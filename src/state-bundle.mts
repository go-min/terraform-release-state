import {
  backupBundleNames,
  backupObjectName,
  bundleAssets,
  manifestName,
  metadataName,
  signatureName,
  type BundleAssets,
} from "./asset-names.mjs";
import { decryptState } from "./encryption.mjs";
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
import {
  createManifestSignature,
  verifyManifestSignature,
  type SignatureVerification,
} from "./signing.mjs";
import {
  createBackupMetadata,
  createStateMetadata,
  parseBackupMetadata,
  parseStateMetadata,
} from "./state-metadata.mjs";
import type {
  Asset,
  EncryptionConfig,
  SigningConfig,
  StateManagerContext,
} from "./types.mjs";

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
  plaintext?: Buffer;
  manifest?: StateManifest;
  manifestData?: Buffer;
  signatureData?: Buffer;
  metadataData?: Buffer;
  format: "legacy" | "manifest-v1";
  signature: SignatureVerification;
  storedVerification: VerificationStatus;
  plaintextVerification: VerificationStatus;
  warnings: string[];
};
export type BundleData = {
  state: Buffer;
  metadata?: Buffer;
  manifest: Buffer;
  signature?: Buffer;
  parsedManifest: StateManifest;
};
type LoadOptions = {
  plaintext: "required" | "if-available";
  allowEncryptionMigration?: boolean;
};

function encryption(context: StateManagerContext): EncryptionConfig {
  return (
    context.config.encryption || {
      mode: "none",
      recipients: [],
      identities: [],
    }
  );
}
function signing(context: StateManagerContext): SigningConfig {
  return (
    context.config.signing || {
      policy: "allow-unsigned",
      privateKeyPem: "",
      verificationKeys: [],
    }
  );
}
function companion(bundle: BundleAssets): Asset | undefined {
  return bundle.metadata || bundle.manifest || bundle.signature;
}
function assertIdentity(
  manifest: StateManifest,
  name: string,
  role: ObjectRole,
): void {
  if (manifest.object.name !== name || manifest.object.role !== role) {
    failWithCode(
      "TRS_MANIFEST_OBJECT_MISMATCH",
      `Manifest object ${manifest.object.role}/${manifest.object.name} does not match expected ${role}/${name}.`,
    );
  }
}
function verifyStored(manifest: StateManifest, data: Buffer): void {
  if (
    manifest.content.stored.size_bytes !== data.length ||
    manifest.content.stored.sha256 !== sha256(data)
  ) {
    failWithCode(
      "TRS_STORED_DIGEST_MISMATCH",
      `Stored state does not match manifest digest and size for ${manifest.object.name}.`,
    );
  }
}
function verifyPlaintext(manifest: StateManifest, data: Buffer): void {
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
async function plaintextFor(
  context: StateManagerContext,
  manifest: StateManifest,
  stored: Buffer,
  options: LoadOptions,
): Promise<{ data?: Buffer; status: VerificationStatus }> {
  const config = encryption(context);
  if (manifest.encryption.mode === "none") {
    verifyPlaintext(manifest, stored);
    return { data: stored, status: "verified" };
  }
  if (config.mode !== "age" && !options.allowEncryptionMigration) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "Configured encryption=none does not match manifest encryption=age.",
    );
  }
  if (options.plaintext === "if-available" && config.identities.length === 0) {
    return { status: "not-performed" };
  }
  const plaintext = await decryptState({ ...config, mode: "age" }, stored);
  verifyPlaintext(manifest, plaintext);
  return { data: plaintext, status: "verified" };
}
async function loadManifest(
  context: StateManagerContext,
  assets: BundleAssets,
  name: string,
  role: ObjectRole,
  stored: Buffer,
  options: LoadOptions,
): Promise<LoadedStateBundle> {
  if (!assets.manifest) throw new Error("internal: missing manifest");
  const [manifestData, signatureData, metadataData] = await Promise.all([
    downloadAsset(context.octokit, context.config.target, assets.manifest),
    assets.signature
      ? downloadAsset(context.octokit, context.config.target, assets.signature)
      : undefined,
    assets.metadata
      ? downloadAsset(context.octokit, context.config.target, assets.metadata)
      : undefined,
  ]);
  const manifest = parseManifest(manifestData);
  assertIdentity(manifest, name, role);
  verifyStored(manifest, stored);
  if (role === "backup") {
    if (!metadataData)
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Manifest backup ${name} is missing ${metadataName(name)}.`,
      );
    parseBackupMetadata(
      metadataData,
      context.config.assetName,
      manifest.encryption.mode,
      stored,
    );
  } else if (manifest.encryption.mode === "age") {
    if (!metadataData)
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Encrypted current bundle ${name} is missing ${metadataName(name)}.`,
      );
    parseStateMetadata(metadataData, "age", stored);
  } else if (metadataData) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      `Unencrypted current bundle ${name} has unexpected compatibility metadata.`,
    );
  }
  const signature = verifyManifestSignature(
    manifestName(name),
    manifestData,
    signatureData,
    signing(context),
  );
  const plaintext = await plaintextFor(context, manifest, stored, options);
  return {
    objectName: name,
    role,
    assets,
    stored,
    plaintext: plaintext.data,
    manifest,
    manifestData,
    signatureData,
    metadataData,
    format: "manifest-v1",
    signature,
    storedVerification: "verified",
    plaintextVerification: plaintext.status,
    warnings: signature.status === "unsigned" ? ["TRS_UNSIGNED_MANIFEST"] : [],
  };
}
function legacyMode(
  metadata: Buffer | undefined,
  fallback: EncryptionConfig["mode"],
): EncryptionConfig["mode"] {
  if (!metadata) return fallback;
  try {
    const parsed = JSON.parse(metadata.toString("utf8")) as {
      encryption?: unknown;
    };
    return parsed.encryption === "age" ? "age" : fallback;
  } catch {
    return fallback;
  }
}
async function loadLegacy(
  context: StateManagerContext,
  assets: BundleAssets,
  name: string,
  role: ObjectRole,
  stored: Buffer,
  options: LoadOptions,
): Promise<LoadedStateBundle> {
  if (assets.signature)
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      `Signature ${signatureName(name)} exists without ${manifestName(name)}.`,
    );
  const metadataData = assets.metadata
    ? await downloadAsset(
        context.octokit,
        context.config.target,
        assets.metadata,
      )
    : undefined;
  const config = encryption(context);
  const mode = legacyMode(metadataData, config.mode);
  let storedVerification: VerificationStatus = "not-recorded";
  let plaintextVerification: VerificationStatus = "not-recorded";
  let plaintext: Buffer | undefined;
  if (metadataData) {
    if (role === "current") parseStateMetadata(metadataData, mode, stored);
    else
      parseBackupMetadata(metadataData, context.config.assetName, mode, stored);
    storedVerification = "verified";
  }
  if (
    mode === "age" ||
    stored.subarray(0, 22).toString("utf8") === "age-encryption.org/v1\n"
  ) {
    if (config.mode !== "age" && !options.allowEncryptionMigration)
      failWithCode(
        "TRS_CONFIG_INVALID",
        "Configured encryption=none does not match legacy age state.",
      );
    if (options.plaintext === "required" || config.identities.length > 0) {
      plaintext = await decryptState({ ...config, mode: "age" }, stored);
      plaintextVerification = "authenticated";
    } else plaintextVerification = "not-performed";
  } else plaintext = stored;
  const signature = verifyManifestSignature(
    manifestName(name),
    Buffer.alloc(0),
    undefined,
    signing(context),
  );
  return {
    objectName: name,
    role,
    assets,
    stored,
    plaintext,
    metadataData,
    format: "legacy",
    signature,
    storedVerification,
    plaintextVerification,
    warnings: ["TRS_LEGACY_UNSIGNED"],
  };
}
export async function loadStateBundle(
  context: StateManagerContext,
  releaseAssets: Asset[],
  name: string,
  role: ObjectRole,
  options: LoadOptions,
): Promise<LoadedStateBundle> {
  const assets = bundleAssets(releaseAssets, name);
  if (!assets.state) {
    const found = companion(assets);
    if (found)
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `State object ${name} is missing but companion asset ${found.name} exists.`,
      );
    failWithCode(
      "TRS_OBJECT_NOT_FOUND",
      `State object ${name} does not exist in the Release.`,
    );
  }
  const stored = await downloadAsset(
    context.octokit,
    context.config.target,
    assets.state,
  );
  return assets.manifest
    ? loadManifest(context, assets, name, role, stored, options)
    : loadLegacy(context, assets, name, role, stored, options);
}

function bundleData(
  input: ManifestInput,
  context: StateManagerContext | undefined,
  metadata?: Buffer,
): BundleData {
  const parsedManifest = createManifest(input);
  const manifest = serializeManifest(parsedManifest);
  const signature = context
    ? createManifestSignature(
        manifestName(input.name),
        manifest,
        signing(context),
      )
    : undefined;
  return {
    state: input.stored,
    metadata:
      metadata ||
      (input.encryptionMode === "age"
        ? createStateMetadata(input.stored)
        : undefined),
    manifest,
    signature,
    parsedManifest,
  };
}
export function createBundleData(
  input: ManifestInput,
  contextOrMetadata?: StateManagerContext | Buffer,
  legacyMetadata?: Buffer,
): BundleData {
  return bundleData(
    input,
    Buffer.isBuffer(contextOrMetadata) ? undefined : contextOrMetadata,
    Buffer.isBuffer(contextOrMetadata) ? contextOrMetadata : legacyMetadata,
  );
}
export function createBundleDataFromManifest(
  manifestInput: StateManifest,
  stored: Buffer,
  contextOrMetadata?: StateManagerContext | Buffer,
  legacyMetadata?: Buffer,
): BundleData {
  const manifest = serializeManifest(manifestInput);
  const context = Buffer.isBuffer(contextOrMetadata)
    ? undefined
    : contextOrMetadata;
  const metadata = Buffer.isBuffer(contextOrMetadata)
    ? contextOrMetadata
    : legacyMetadata;
  return {
    state: stored,
    metadata,
    manifest,
    signature: context
      ? createManifestSignature(
          manifestName(manifestInput.object.name),
          manifest,
          signing(context),
        )
      : undefined,
    parsedManifest: manifestInput,
  };
}
export function compatibilityBackupMetadata(input: {
  stored: Buffer;
  currentAsset: string;
  encryption?: "none" | "age";
  sourceCommit: string;
  workflowRunId: string;
  actionVersion: string;
  createdAt: string;
}): Buffer {
  return createBackupMetadata({
    ...input,
    encryption: input.encryption || "none",
  });
}
export async function assertNoUnsupportedStorage(
  context: StateManagerContext,
  assets: Asset[],
): Promise<void> {
  await loadCompleteReleaseBundles(context, assets);
}
export async function loadCompleteReleaseBundles(
  context: StateManagerContext,
  assets: Asset[],
): Promise<Map<string, LoadedStateBundle>> {
  const loaded = new Map<string, LoadedStateBundle>();
  const current = bundleAssets(assets, context.config.assetName);
  if (current.state || companion(current))
    loaded.set(
      context.config.assetName,
      await loadStateBundle(
        context,
        assets,
        context.config.assetName,
        "current",
        { plaintext: "if-available", allowEncryptionMigration: true },
      ),
    );
  for (const name of backupBundleNames(assets, context.config.assetName)) {
    loaded.set(
      name,
      await loadStateBundle(context, assets, name, "backup", {
        plaintext: "if-available",
        allowEncryptionMigration: true,
      }),
    );
  }
  return loaded;
}
export function objectNameForAsset(
  assetName: string,
  stateAssetName: string,
): string | undefined {
  if (
    assetName === stateAssetName ||
    assetName === manifestName(stateAssetName) ||
    assetName === metadataName(stateAssetName) ||
    assetName === signatureName(stateAssetName)
  )
    return stateAssetName;
  return backupObjectName(assetName, stateAssetName);
}
