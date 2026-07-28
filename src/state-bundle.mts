import {
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
  createStateMetadata,
  parseBackupMetadata,
  parseStateMetadata,
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
  legacyMigration?: boolean;
};

function signingConfig(context: StateManagerContext) {
  return (
    context.config.signing || {
      policy: "allow-unsigned" as const,
      privateKeyPem: "",
      verificationKeys: [],
    }
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

function assertEncryptionMode(
  context: StateManagerContext,
  manifest: StateManifest,
): void {
  if (manifest.encryption.mode !== context.config.encryption.mode) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      `Configured encryption=${context.config.encryption.mode} does not match manifest encryption=${manifest.encryption.mode}.`,
    );
  }
}

async function plaintextForManifest(
  context: StateManagerContext,
  manifest: StateManifest,
  stored: Buffer,
  requirement: LoadOptions["plaintext"],
): Promise<{ data?: Buffer; status: VerificationStatus }> {
  if (manifest.encryption.mode === "none") {
    verifyPlaintext(manifest, stored);
    return { data: stored, status: "verified" };
  }
  if (
    requirement === "if-available" &&
    context.config.encryption.identities.length === 0
  ) {
    return { status: "not-performed" };
  }
  const plaintext = await decryptState(context.config.encryption, stored);
  verifyPlaintext(manifest, plaintext);
  return { data: plaintext, status: "verified" };
}

async function loadManifestBundle(
  context: StateManagerContext,
  assets: BundleAssets,
  objectName: string,
  role: ObjectRole,
  stored: Buffer,
  options: LoadOptions,
): Promise<LoadedStateBundle> {
  if (!assets.manifest) {
    throw new Error("internal: manifest asset missing");
  }
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
  assertObjectIdentity(manifest, objectName, role);
  assertEncryptionMode(context, manifest);
  verifyStored(manifest, stored);
  if (role === "backup") {
    if (!metadataData) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Manifest bundle ${objectName} is missing compatibility metadata ${metadataName(objectName)}.`,
      );
    }
    parseBackupMetadata(
      metadataData,
      context.config.assetName,
      manifest.encryption.mode,
      stored,
    );
  } else if (manifest.encryption.mode === "age") {
    if (!metadataData) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Manifest bundle ${objectName} is missing compatibility metadata ${metadataName(objectName)}.`,
      );
    }
    parseStateMetadata(metadataData, "age", stored);
  } else if (metadataData) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      `Unencrypted manifest bundle ${objectName} has unexpected compatibility metadata.`,
    );
  }
  const signature = verifyManifestSignature(
    manifestName(objectName),
    manifestData,
    signatureData,
    signingConfig(context),
  );
  const plaintext = await plaintextForManifest(
    context,
    manifest,
    stored,
    options.plaintext,
  );
  return {
    objectName,
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

async function loadLegacyBundle(
  context: StateManagerContext,
  assets: BundleAssets,
  objectName: string,
  role: ObjectRole,
  stored: Buffer,
  options: LoadOptions,
): Promise<LoadedStateBundle> {
  if (assets.signature) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      `Signature ${signatureName(objectName)} exists without ${manifestName(objectName)}.`,
    );
  }
  const metadataData = assets.metadata
    ? await downloadAsset(
        context.octokit,
        context.config.target,
        assets.metadata,
      )
    : undefined;
  let plaintext: Buffer | undefined;
  let storedVerification: VerificationStatus = "not-recorded";
  let plaintextVerification: VerificationStatus = "not-recorded";
  if (metadataData) {
    if (role === "current") {
      parseStateMetadata(metadataData, context.config.encryption.mode, stored);
    } else {
      parseBackupMetadata(
        metadataData,
        context.config.assetName,
        context.config.encryption.mode,
        stored,
      );
    }
    storedVerification = "verified";
    if (
      options.legacyMigration &&
      context.config.encryption.identities.length === 0
    ) {
      failWithCode(
        "TRS_LEGACY_MIGRATION_IDENTITY_REQUIRED",
        "Migrating legacy age-encrypted state requires age-identities before any remote mutation.",
      );
    }
    if (
      options.plaintext === "required" ||
      context.config.encryption.identities.length > 0
    ) {
      plaintext = await decryptState(context.config.encryption, stored);
      plaintextVerification = "authenticated";
    } else {
      plaintextVerification = "not-performed";
    }
  } else {
    if (context.config.encryption.mode === "age") {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Encrypted state is missing legacy metadata ${metadataName(objectName)}.`,
      );
    }
    if (stored.subarray(0, 22).toString("utf8") === "age-encryption.org/v1\n") {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        "State asset appears encrypted but legacy metadata is missing.",
      );
    }
    plaintext = stored;
  }
  const signature = verifyManifestSignature(
    manifestName(objectName),
    Buffer.alloc(0),
    undefined,
    signingConfig(context),
  );
  return {
    objectName,
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
  objectName: string,
  role: ObjectRole,
  options: LoadOptions,
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
  const stored = await downloadAsset(
    context.octokit,
    context.config.target,
    assets.state,
  );
  return assets.manifest
    ? loadManifestBundle(context, assets, objectName, role, stored, options)
    : loadLegacyBundle(context, assets, objectName, role, stored, options);
}

export function createBundleData(
  manifestInput: ManifestInput,
  context: StateManagerContext,
  legacyMetadata?: Buffer,
): BundleData {
  const parsedManifest = createManifest(manifestInput);
  const manifest = serializeManifest(parsedManifest);
  const signature = createManifestSignature(
    manifestName(manifestInput.name),
    manifest,
    signingConfig(context),
  );
  return {
    state: manifestInput.stored,
    metadata:
      legacyMetadata ||
      (manifestInput.encryptionMode === "age"
        ? createStateMetadata(manifestInput.stored)
        : undefined),
    manifest,
    signature,
    parsedManifest,
  };
}

export function createBundleDataFromManifest(
  parsedManifest: StateManifest,
  stored: Buffer,
  context: StateManagerContext,
  legacyMetadata?: Buffer,
): BundleData {
  const manifest = serializeManifest(parsedManifest);
  const signature = createManifestSignature(
    manifestName(parsedManifest.object.name),
    manifest,
    signingConfig(context),
  );
  return {
    state: stored,
    metadata: legacyMetadata,
    manifest,
    signature,
    parsedManifest,
  };
}
