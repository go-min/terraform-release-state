import {
  backupBundleNames,
  backupObjectName,
  bundleAssets,
  manifestName,
  metadataName,
  signatureName,
  type BundleAssets,
} from "./asset-names.mjs";
import { failWithCode } from "./errors.mjs";
import { downloadAsset } from "./github-api.mjs";
import { sha256 } from "./integrity.mjs";
import {
  createManifest,
  parseManifest,
  serializeManifest,
  type ManifestInput,
  type ObjectRole,
  type StateManifest,
} from "./manifest.mjs";
import { V04_MIGRATION_HINT } from "./protocol.mjs";
import {
  createBackupMetadata,
  parseBackupMetadata,
} from "./state-metadata.mjs";
import type { Asset, StateManagerContext } from "./types.mjs";

export type VerificationStatus =
  | "verified"
  | "authenticated"
  | "not-recorded"
  | "not-performed";

export type LoadedStateBundle = {
  objectName: string;
  role: ObjectRole;
  assets: BundleAssets;
  stored: Buffer;
  plaintext: Buffer;
  manifest?: StateManifest;
  manifestData?: Buffer;
  signatureData?: Buffer;
  metadataData?: Buffer;
  format: "legacy" | "manifest-v1";
  signature: { status: "unsigned"; keyFingerprint: "" };
  storedVerification: VerificationStatus;
  plaintextVerification: VerificationStatus;
  warnings: string[];
};

export type BundleData = {
  state: Buffer;
  metadata?: Buffer;
  manifest: Buffer;
  parsedManifest: StateManifest;
};

type LoadOptions = {
  plaintext: "required" | "if-available";
};

function migrationRequired(detail: string): never {
  failWithCode(
    "TRS_V04_MIGRATION_REQUIRED",
    `${detail} v0.5 accepts only plaintext unsigned legacy or v0.4 bundles. ${V04_MIGRATION_HINT}`,
  );
}

function anyCompanion(bundle: BundleAssets): Asset | undefined {
  return bundle.metadata || bundle.manifest || bundle.signature;
}

function assertObjectIdentity(
  manifest: StateManifest,
  objectName: string,
  role: ObjectRole,
): void {
  if (manifest.object.name !== objectName || manifest.object.role !== role) {
    failWithCode(
      "TRS_MANIFEST_OBJECT_MISMATCH",
      `Manifest object ${manifest.object.role}/${manifest.object.name} does not match expected ${role}/${objectName}.`,
    );
  }
}

function verifyContent(manifest: StateManifest, data: Buffer): void {
  if (
    manifest.content.stored.size_bytes !== data.length ||
    manifest.content.stored.sha256 !== sha256(data)
  ) {
    failWithCode(
      "TRS_STORED_DIGEST_MISMATCH",
      `Stored state does not match manifest digest and size for ${manifest.object.name}.`,
    );
  }
  if (
    manifest.content.plaintext.size_bytes !== data.length ||
    manifest.content.plaintext.sha256 !== sha256(data)
  ) {
    failWithCode(
      "TRS_PLAINTEXT_DIGEST_MISMATCH",
      `Plaintext state does not match manifest digest and size for ${manifest.object.name}.`,
    );
  }
}

function metadataEncryption(data: Buffer): unknown {
  try {
    return (JSON.parse(data.toString("utf8")) as { encryption?: unknown })
      .encryption;
  } catch {
    return undefined;
  }
}

async function loadManifestBundle(
  context: StateManagerContext,
  assets: BundleAssets,
  objectName: string,
  role: ObjectRole,
  stored: Buffer,
): Promise<LoadedStateBundle> {
  if (!assets.manifest) throw new Error("internal: manifest asset missing");
  if (assets.signature) {
    migrationRequired(
      `Signed bundle ${objectName} includes ${signatureName(objectName)}.`,
    );
  }
  const [manifestData, metadataData] = await Promise.all([
    downloadAsset(context.octokit, context.config.target, assets.manifest),
    assets.metadata
      ? downloadAsset(context.octokit, context.config.target, assets.metadata)
      : undefined,
  ]);
  const manifest = parseManifest(manifestData);
  assertObjectIdentity(manifest, objectName, role);
  if (manifest.encryption.mode !== "none") {
    migrationRequired(`Bundle ${objectName} uses age encryption.`);
  }
  verifyContent(manifest, stored);
  if (role === "backup") {
    if (!metadataData) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Manifest backup ${objectName} is missing ${metadataName(objectName)}.`,
      );
    }
    if (metadataEncryption(metadataData) === "age") {
      migrationRequired(`Backup ${objectName} has age compatibility metadata.`);
    }
    parseBackupMetadata(metadataData, context.config.assetName, "none", stored);
  } else if (metadataData) {
    migrationRequired(
      `Current bundle ${objectName} has age compatibility metadata.`,
    );
  }
  return {
    objectName,
    role,
    assets,
    stored,
    plaintext: stored,
    manifest,
    manifestData,
    metadataData,
    format: "manifest-v1",
    signature: { status: "unsigned", keyFingerprint: "" },
    storedVerification: "verified",
    plaintextVerification: "verified",
    warnings: [],
  };
}

async function loadLegacyBundle(
  context: StateManagerContext,
  assets: BundleAssets,
  objectName: string,
  role: ObjectRole,
  stored: Buffer,
): Promise<LoadedStateBundle> {
  if (assets.signature) {
    migrationRequired(
      `Signature ${signatureName(objectName)} exists for legacy object ${objectName}.`,
    );
  }
  const metadataData = assets.metadata
    ? await downloadAsset(
        context.octokit,
        context.config.target,
        assets.metadata,
      )
    : undefined;
  let storedVerification: VerificationStatus = "not-recorded";
  if (metadataData) {
    if (role === "current" || metadataEncryption(metadataData) === "age") {
      migrationRequired(`Legacy object ${objectName} uses age metadata.`);
    }
    parseBackupMetadata(metadataData, context.config.assetName, "none", stored);
    storedVerification = "verified";
  }
  if (stored.subarray(0, 22).toString("utf8") === "age-encryption.org/v1\n") {
    migrationRequired(`Legacy object ${objectName} contains age ciphertext.`);
  }
  return {
    objectName,
    role,
    assets,
    stored,
    plaintext: stored,
    metadataData,
    format: "legacy",
    signature: { status: "unsigned", keyFingerprint: "" },
    storedVerification,
    plaintextVerification: "not-recorded",
    warnings: ["TRS_LEGACY_UNSIGNED"],
  };
}

export async function loadStateBundle(
  context: StateManagerContext,
  releaseAssets: Asset[],
  objectName: string,
  role: ObjectRole,
  _options: LoadOptions,
): Promise<LoadedStateBundle> {
  const assets = bundleAssets(releaseAssets, objectName);
  if (!assets.state) {
    const companion = anyCompanion(assets);
    if (companion) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `State object ${objectName} is missing but companion asset ${companion.name} exists.`,
      );
    }
    failWithCode(
      "TRS_OBJECT_NOT_FOUND",
      `State object ${objectName} does not exist in the Release.`,
    );
  }
  if (assets.signature) {
    migrationRequired(`Signed bundle ${objectName} was encountered.`);
  }
  const stored = await downloadAsset(
    context.octokit,
    context.config.target,
    assets.state,
  );
  return assets.manifest
    ? loadManifestBundle(context, assets, objectName, role, stored)
    : loadLegacyBundle(context, assets, objectName, role, stored);
}

export async function assertNoUnsupportedStorage(
  context: StateManagerContext,
  assets: Asset[],
): Promise<void> {
  for (const asset of assets) {
    if (asset.name.endsWith(".manifest.sig.json")) {
      migrationRequired(`Signed asset ${asset.name} was encountered.`);
    }
  }
  const objectNames = [
    context.config.assetName,
    ...backupBundleNames(assets, context.config.assetName),
  ];
  for (const objectName of objectNames) {
    const bundle = bundleAssets(assets, objectName);
    if (bundle.manifest) {
      const data = await downloadAsset(
        context.octokit,
        context.config.target,
        bundle.manifest,
      );
      const manifest = parseManifest(data);
      if (manifest.encryption.mode !== "none") {
        migrationRequired(`Bundle ${objectName} uses age encryption.`);
      }
    }
    if (bundle.metadata) {
      const data = await downloadAsset(
        context.octokit,
        context.config.target,
        bundle.metadata,
      );
      if (
        objectName === context.config.assetName ||
        metadataEncryption(data) === "age"
      ) {
        migrationRequired(`Bundle ${objectName} uses age metadata.`);
      }
    }
    if (bundle.state) {
      const data = await downloadAsset(
        context.octokit,
        context.config.target,
        bundle.state,
      );
      if (data.subarray(0, 22).toString("utf8") === "age-encryption.org/v1\n") {
        migrationRequired(`Bundle ${objectName} contains age ciphertext.`);
      }
    }
  }
}

export async function loadCompleteReleaseBundles(
  context: StateManagerContext,
  assets: Asset[],
): Promise<Map<string, LoadedStateBundle>> {
  await assertNoUnsupportedStorage(context, assets);
  const loaded = new Map<string, LoadedStateBundle>();
  const current = bundleAssets(assets, context.config.assetName);
  if (current.state || anyCompanion(current)) {
    loaded.set(
      context.config.assetName,
      await loadStateBundle(
        context,
        assets,
        context.config.assetName,
        "current",
        { plaintext: "required" },
      ),
    );
  }
  for (const name of backupBundleNames(assets, context.config.assetName)) {
    loaded.set(
      name,
      await loadStateBundle(context, assets, name, "backup", {
        plaintext: "required",
      }),
    );
  }
  return loaded;
}

export function createBundleData(
  manifestInput: ManifestInput,
  legacyMetadata?: Buffer,
): BundleData {
  if (
    manifestInput.encryptionMode !== "none" ||
    manifestInput.encryptionKeyFingerprint !== null ||
    !manifestInput.stored.equals(manifestInput.plaintext)
  ) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "v0.5 can create only plaintext unsigned state bundles.",
    );
  }
  const parsedManifest = createManifest(manifestInput);
  return {
    state: manifestInput.stored,
    metadata: legacyMetadata,
    manifest: serializeManifest(parsedManifest),
    parsedManifest,
  };
}

export function createBundleDataFromManifest(
  parsedManifest: StateManifest,
  stored: Buffer,
  legacyMetadata?: Buffer,
): BundleData {
  if (
    parsedManifest.encryption.mode !== "none" ||
    parsedManifest.content.stored.sha256 !== sha256(stored) ||
    parsedManifest.content.plaintext.sha256 !== sha256(stored)
  ) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "v0.5 can copy only verified plaintext unsigned manifests.",
    );
  }
  return {
    state: stored,
    metadata: legacyMetadata,
    manifest: serializeManifest(parsedManifest),
    parsedManifest,
  };
}

export function compatibilityBackupMetadata(input: {
  stored: Buffer;
  currentAsset: string;
  sourceCommit: string;
  workflowRunId: string;
  actionVersion: string;
  createdAt: string;
}): Buffer {
  return createBackupMetadata({ ...input, encryption: "none" });
}

export function objectNameForAsset(
  assetName: string,
  stateAssetName: string,
): string | undefined {
  if (assetName === stateAssetName) return stateAssetName;
  if (
    assetName === manifestName(stateAssetName) ||
    assetName === metadataName(stateAssetName) ||
    assetName === signatureName(stateAssetName)
  ) {
    return stateAssetName;
  }
  return backupObjectName(assetName, stateAssetName);
}
