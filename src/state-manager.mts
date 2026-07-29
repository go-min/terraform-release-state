import { existsSync } from "node:fs";
import { core } from "./action-core.mjs";
import {
  bundleAssets,
  manifestName,
  metadataName,
  signatureName,
  type BundleAssets,
} from "./asset-names.mjs";
import { createBackup, retainBackups } from "./backup-manager.mjs";
import { encryptState } from "./encryption.mjs";
import { failWithCode } from "./errors.mjs";
import {
  createRelease,
  deleteAsset,
  downloadAsset,
  getRelease,
  listAssets,
  managedReleaseBody,
  updateReleaseBody,
  uploadAsset,
} from "./github-api.mjs";
import { assetDigest, sha256 } from "./integrity.mjs";
import { ageRecipientsFingerprint } from "./manifest.mjs";
import { marker, sameAssetMarker, sameMarker } from "./marker.mjs";
import {
  createBundleData,
  loadCompleteReleaseBundles,
  loadStateBundle,
  type BundleData,
  type LoadedStateBundle,
} from "./state-bundle.mjs";
import { readStateFile, writeStateFile } from "./state-files.mjs";
import { readRestoreReceipt, writeRestoreReceipt } from "./receipt.mjs";
import type { Asset, Release, StateManagerContext } from "./types.mjs";

function encryptionConfig(context: StateManagerContext) {
  return (
    context.config.encryption || {
      mode: "none" as const,
      recipients: [],
      identities: [],
    }
  );
}

/**
 * A replacement must never silently weaken a protected current bundle.  We
 * load every bundle before mutation, but an age bundle can intentionally be
 * loaded without an identity during inventory.  Saving over it is different:
 * it needs the verified plaintext for the rollback bundle.  Likewise, a
 * signed current must be re-signed rather than converted to unsigned bytes.
 */
function assertCurrentCanBeReplaced(
  context: StateManagerContext,
  previous: LoadedStateBundle | undefined,
): void {
  if (!previous) return;
  if (previous.manifest?.encryption.mode === "age" && !previous.plaintext) {
    failWithCode(
      "TRS_DECRYPTION_FAILED",
      "age-identities is required to verify and preserve the existing encrypted state before save.",
    );
  }
  if (
    previous.signature.status === "verified" &&
    !context.config.signing?.privateKeyPem
  ) {
    failWithCode(
      "TRS_SIGNATURE_REQUIRED",
      "signing-private-key is required to preserve the existing signed state before save.",
    );
  }
}

function emitVerificationOutputs(bundle: LoadedStateBundle): void {
  core.setOutput("storage-format", bundle.format);
  if (bundle.manifest) {
    core.setOutput("manifest-schema-version", bundle.manifest.schema_version);
  }
  core.setOutput("signature-status", bundle.signature.status);
  if (bundle.signature.keyFingerprint) {
    core.setOutput(
      "signature-key-fingerprint",
      bundle.signature.keyFingerprint,
    );
  }
  core.setOutput("stored-state-verification", bundle.storedVerification);
  core.setOutput("plaintext-state-verification", bundle.plaintextVerification);
  core.setOutput("warning-count", bundle.warnings.length);
  core.setOutput("warning-codes-json", JSON.stringify(bundle.warnings));
  for (const warning of bundle.warnings) {
    core.warning(
      `[${warning}] ${
        warning === "TRS_LEGACY_UNSIGNED"
          ? "State uses the unsigned legacy storage format; a successful save migrates it in place."
          : "State manifest is unsigned because signature-policy=allow-unsigned."
      }`,
    );
  }
}

function emitOutputs(
  operation: string,
  release: Release,
  asset: Asset | undefined,
  storedData: Buffer | undefined,
  plaintextData: Buffer | undefined,
  bootstrapped = false,
): void {
  core.setOutput("operation", operation);
  core.setOutput("release-id", release.id);
  core.setOutput("bootstrapped", bootstrapped);
  core.setOutput("remote-state-marker", marker(asset));
  if (asset) {
    core.setOutput("state-asset-id", asset.id);
    core.setOutput("state-digest", assetDigest(asset));
  }
  if (storedData) {
    core.setOutput("stored-state-sha256", sha256(storedData));
  }
  if (plaintextData) {
    const plaintextDigest = sha256(plaintextData);
    core.setOutput("state-sha256", plaintextDigest);
    core.setOutput("plaintext-state-sha256", plaintextDigest);
  }
}

async function getOrBootstrapRelease(
  context: StateManagerContext,
): Promise<Release> {
  const { octokit, config } = context;
  const existing = await getRelease(octokit, config.target, config.tag);
  if (existing) return existing;
  if (!config.bootstrap) {
    failWithCode(
      "TRS_OBJECT_NOT_FOUND",
      `State release ${config.tag} does not exist; set bootstrap=true explicitly.`,
    );
  }
  return createRelease(octokit, config.target, config.tag, config.assetName);
}

async function getSaveRelease(
  context: StateManagerContext,
): Promise<{ release: Release; created: boolean }> {
  const existing = await getRelease(
    context.octokit,
    context.config.target,
    context.config.tag,
  );
  if (existing) return { release: existing, created: false };
  failWithCode(
    "TRS_OBJECT_NOT_FOUND",
    `State release ${context.config.tag} does not exist. Run restore first; only restore may bootstrap storage.`,
  );
}

function hasCompanion(bundle: BundleAssets): Asset | undefined {
  return bundle.metadata || bundle.manifest || bundle.signature;
}

function sameOptionalAsset(
  expected: Asset | undefined,
  actual: Asset | undefined,
): boolean {
  return (
    (!expected && !actual) ||
    (Boolean(expected) &&
      Boolean(actual) &&
      sameAssetMarker(expected as Asset, actual as Asset))
  );
}

export function sameBundle(
  expected: BundleAssets,
  actual: BundleAssets,
): boolean {
  return (
    sameOptionalAsset(expected.state, actual.state) &&
    sameOptionalAsset(expected.metadata, actual.metadata) &&
    sameOptionalAsset(expected.manifest, actual.manifest) &&
    sameOptionalAsset(expected.signature, actual.signature)
  );
}

export async function readStoredState(
  context: StateManagerContext,
): Promise<Buffer> {
  const { octokit, config } = context;
  const release = await getRelease(octokit, config.target, config.tag);
  if (!release) {
    failWithCode(
      "TRS_OBJECT_NOT_FOUND",
      `State release ${config.tag} does not exist.`,
    );
  }
  const assets = await listAssets(octokit, config.target, release.id);
  const bundle = await loadStateBundle(
    context,
    assets,
    config.assetName,
    "current",
    { plaintext: "required" },
  );
  emitVerificationOutputs(bundle);
  if (!bundle.plaintext) {
    failWithCode(
      "TRS_PLAINTEXT_DIGEST_MISMATCH",
      "Plaintext state was not available after required verification.",
    );
  }
  return bundle.plaintext;
}

export async function restore(context: StateManagerContext): Promise<void> {
  const { octokit, config } = context;
  const release = await getOrBootstrapRelease(context);
  const assets = await listAssets(octokit, config.target, release.id);
  const currentAssets = bundleAssets(assets, config.assetName);
  if (!currentAssets.state) {
    const companion = hasCompanion(currentAssets);
    if (companion) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `State asset ${config.assetName} is missing but companion ${companion.name} exists.`,
      );
    }
    if (!config.bootstrap) {
      failWithCode(
        "TRS_OBJECT_NOT_FOUND",
        `State asset ${config.assetName} is missing from release ${config.tag}.`,
      );
    }
    if (existsSync(config.statePath)) {
      failWithCode(
        "TRS_CONFIG_INVALID",
        `State asset is missing but local state already exists at ${config.statePath}.`,
      );
    }
    core.setOutput("operation", "restore");
    core.setOutput("release-id", release.id);
    core.setOutput("bootstrapped", true);
    core.setOutput("remote-state-marker", "absent");
    core.setOutput("storage-format", "absent");
    core.setOutput("signature-status", "unsigned");
    core.setOutput("stored-state-verification", "not-performed");
    core.setOutput("plaintext-state-verification", "not-performed");
    core.setOutput("warning-count", 0);
    core.setOutput("warning-codes-json", "[]");
    core.setOutput("state-write-committed", false);
    core.setOutput("state-phase", "complete");
    core.setOutput("state-status", "success");
    writeRestoreReceipt(config, "absent");
    return;
  }
  const bundle = await loadStateBundle(
    context,
    assets,
    config.assetName,
    "current",
    { plaintext: "required" },
  );
  if (!bundle.plaintext) {
    failWithCode(
      "TRS_PLAINTEXT_DIGEST_MISMATCH",
      "Plaintext state was not available after required verification.",
    );
  }
  writeStateFile(config.statePath, config.workspace, bundle.plaintext);
  emitOutputs(
    "restore",
    release,
    currentAssets.state,
    bundle.stored,
    bundle.plaintext,
  );
  emitVerificationOutputs(bundle);
  core.setOutput("state-write-committed", false);
  core.setOutput("state-phase", "complete");
  core.setOutput("state-status", "success");
  writeRestoreReceipt(config, marker(currentAssets.state));
}

export async function uploadCurrentBundle(
  context: StateManagerContext,
  release: Release,
  data: BundleData,
  uploaded: BundleAssets,
): Promise<void> {
  const { octokit, config } = context;
  uploaded.state = await uploadAsset(
    octokit,
    config.target,
    release.id,
    config.assetName,
    data.state,
  );
  if (data.metadata) {
    uploaded.metadata = await uploadAsset(
      octokit,
      config.target,
      release.id,
      metadataName(config.assetName),
      data.metadata,
      "application/json",
    );
  }
  if (data.signature) {
    uploaded.signature = await uploadAsset(
      octokit,
      config.target,
      release.id,
      signatureName(config.assetName),
      data.signature,
      "application/json",
    );
  }
  uploaded.manifest = await uploadAsset(
    octokit,
    config.target,
    release.id,
    manifestName(config.assetName),
    data.manifest,
    "application/json",
  );
}

export async function deleteBundleAssets(
  context: StateManagerContext,
  bundle: BundleAssets,
): Promise<void> {
  for (const asset of [
    bundle.signature,
    bundle.manifest,
    bundle.metadata,
    bundle.state,
  ]) {
    if (asset) {
      await deleteAsset(context.octokit, context.config.target, asset.id);
    }
  }
}

function previousData(
  previous: LoadedStateBundle,
  kind: keyof BundleAssets,
): Buffer | undefined {
  if (kind === "state") return previous.stored;
  if (kind === "metadata") return previous.metadataData;
  if (kind === "manifest") return previous.manifestData;
  return previous.signatureData;
}

export async function restorePreviousBundle(
  context: StateManagerContext,
  release: Release,
  previous: LoadedStateBundle | undefined,
  replacement: BundleAssets,
): Promise<void> {
  const releaseAssets = await listAssets(
    context.octokit,
    context.config.target,
    release.id,
  );
  const current = bundleAssets(releaseAssets, context.config.assetName);
  for (const kind of ["signature", "manifest", "metadata", "state"] as const) {
    const asset = current[kind];
    if (!asset) continue;
    if (previous?.assets[kind]?.id === asset.id) continue;
    if (replacement[kind]?.id !== asset.id) {
      failWithCode(
        "TRS_REMOTE_CHANGED",
        `Remote ${kind} asset changed during recovery; refusing to overwrite it.`,
      );
    }
    await deleteAsset(context.octokit, context.config.target, asset.id);
  }
  if (!previous) {
    const remaining = bundleAssets(
      await listAssets(context.octokit, context.config.target, release.id),
      context.config.assetName,
    );
    if (remaining.state || hasCompanion(remaining)) {
      failWithCode(
        "TRS_REMOTE_CHANGED",
        "Bootstrap recovery left one or more current bundle assets behind.",
      );
    }
    return;
  }
  const refreshed = bundleAssets(
    await listAssets(context.octokit, context.config.target, release.id),
    context.config.assetName,
  );
  for (const kind of ["state", "metadata", "signature", "manifest"] as const) {
    if (refreshed[kind] || !previous.assets[kind]) continue;
    const data = previousData(previous, kind);
    if (!data) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Cannot recover previous ${kind} asset because its verified bytes are unavailable.`,
      );
    }
    await uploadAsset(
      context.octokit,
      context.config.target,
      release.id,
      previous.assets[kind].name,
      data,
      kind === "state" ? "application/octet-stream" : "application/json",
    );
  }
  const recoveredAssets = await listAssets(
    context.octokit,
    context.config.target,
    release.id,
  );
  const recovered = await loadStateBundle(
    context,
    recoveredAssets,
    context.config.assetName,
    "current",
    { plaintext: "if-available" },
  );
  for (const kind of ["state", "metadata", "signature", "manifest"] as const) {
    if (Boolean(previous.assets[kind]) !== Boolean(recovered.assets[kind])) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Recovered current bundle has an unexpected ${kind} asset set.`,
      );
    }
    const expectedData = previousData(previous, kind);
    const recoveredData = previousData(recovered, kind);
    if (
      expectedData &&
      (!recoveredData || sha256(expectedData) !== sha256(recoveredData))
    ) {
      failWithCode(
        "TRS_STORED_DIGEST_MISMATCH",
        `Recovered current ${kind} bytes do not match the verified previous bundle.`,
      );
    }
  }
}

export async function assertUploadedBundle(
  context: StateManagerContext,
  release: Release,
  uploaded: BundleAssets,
  expected: BundleData,
): Promise<{ assets: BundleAssets; loaded: LoadedStateBundle }> {
  const assets = await listAssets(
    context.octokit,
    context.config.target,
    release.id,
  );
  const listed = bundleAssets(assets, context.config.assetName);
  for (const kind of ["state", "metadata", "signature", "manifest"] as const) {
    if (uploaded[kind]?.id !== listed[kind]?.id) {
      if (uploaded[kind] || listed[kind]) {
        failWithCode(
          "TRS_REMOTE_CHANGED",
          `Current ${kind} asset changed during upload verification.`,
        );
      }
    }
  }
  const expectedData: Record<keyof BundleAssets, Buffer | undefined> = {
    state: expected.state,
    metadata: expected.metadata,
    signature: expected.signature,
    manifest: expected.manifest,
  };
  for (const kind of ["state", "metadata", "signature", "manifest"] as const) {
    const asset = listed[kind];
    const data = expectedData[kind];
    if (!asset || !data) continue;
    const downloaded = await downloadAsset(
      context.octokit,
      context.config.target,
      asset,
    );
    if (sha256(downloaded) !== sha256(data)) {
      failWithCode(
        kind === "state"
          ? "TRS_STORED_DIGEST_MISMATCH"
          : "TRS_MANIFEST_INVALID",
        `Uploaded current ${kind} asset failed checksum verification.`,
      );
    }
  }
  const loaded = await loadStateBundle(
    context,
    assets,
    context.config.assetName,
    "current",
    { plaintext: "if-available" },
  );
  return { assets: listed, loaded };
}

export async function save(context: StateManagerContext): Promise<void> {
  const { octokit, config } = context;
  const encryption = encryptionConfig(context);
  if (!existsSync(config.statePath)) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      `State file not found: ${config.statePath}`,
    );
  }
  const plaintext = readStateFile(config.statePath, config.workspace);
  if (!plaintext.length) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      `State file is empty: ${config.statePath}`,
    );
  }
  const data = await encryptState(encryption, plaintext);
  const expected = readRestoreReceipt(config);
  const releaseResult = await getSaveRelease(context);
  let release = releaseResult.release;
  let assets = await listAssets(octokit, config.target, release.id);
  const previousAssets = bundleAssets(assets, config.assetName);
  const current = previousAssets.state;

  if (expected === "absent" && current) {
    failWithCode(
      "TRS_REMOTE_CHANGED",
      "Remote state appeared after restore; refusing to overwrite it.",
    );
  }
  if (expected !== "absent") {
    if (!current) {
      failWithCode(
        "TRS_REMOTE_CHANGED",
        "Remote state disappeared after restore; refusing to recreate it.",
      );
    }
    if (!sameMarker(expected, current)) {
      failWithCode(
        "TRS_REMOTE_CHANGED",
        "Remote state changed after restore; refusing to overwrite it.",
      );
    }
  }
  if (!current && hasCompanion(previousAssets)) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      "Current state is missing while one or more companion assets remain.",
    );
  }
  // Validate the entire managed namespace before the first Release mutation.
  const loadedBundles = await loadCompleteReleaseBundles(context, assets);
  const previous = loadedBundles.get(config.assetName);
  assertCurrentCanBeReplaced(context, previous);

  const body = managedReleaseBody(config.target, config.tag, config.assetName);
  if (!releaseResult.created && release.body !== body) {
    release = await updateReleaseBody(octokit, config.target, release.id, body);
  }

  let backup = "";
  if (current && previous) {
    backup = await createBackup(context, release, current, previous);
  }

  assets = await listAssets(octokit, config.target, release.id);
  const latest = bundleAssets(assets, config.assetName);
  if (!sameBundle(previousAssets, latest)) {
    failWithCode(
      "TRS_REMOTE_CHANGED",
      "Remote state bundle changed during save; refusing to overwrite it.",
    );
  }

  const parentMarker = current ? marker(current) : null;
  const parentStoredSha256 = previous ? sha256(previous.stored) : null;
  const currentData = createBundleData(
    {
      role: "current",
      name: config.assetName,
      stored: data,
      plaintext,
      encryptionMode: encryption.mode,
      encryptionKeyFingerprint:
        encryption.mode === "age"
          ? ageRecipientsFingerprint(encryption.recipients)
          : null,
      parentMarker,
      parentStoredSha256,
      sourceCommit: config.sourceCommit,
      workflowRunId: config.workflowRunId,
      actionVersion: process.env.GITHUB_ACTION_REF || "unknown",
    },
    context,
  );

  const replacement: BundleAssets = {};
  let verified: LoadedStateBundle;
  let authoritativeAssets: BundleAssets;
  try {
    await deleteBundleAssets(context, latest);
    await uploadCurrentBundle(context, release, currentData, replacement);
    const result = await assertUploadedBundle(
      context,
      release,
      replacement,
      currentData,
    );
    authoritativeAssets = result.assets;
    verified = result.loaded;
  } catch (error) {
    try {
      await restorePreviousBundle(context, release, previous, replacement);
    } catch (recoveryError) {
      throw new Error(
        `State save failed and automatic recovery could not complete: ${
          recoveryError instanceof Error
            ? recoveryError.message
            : "unknown recovery error"
        }`,
        { cause: error },
      );
    }
    throw error;
  }

  const authoritative = authoritativeAssets.state;
  if (!authoritative) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      "Verified current bundle does not contain its state asset.",
    );
  }
  const bootstrapped = !current && expected === "absent";
  emitOutputs("save", release, authoritative, data, plaintext, bootstrapped);
  emitVerificationOutputs({
    ...verified,
    plaintext,
    plaintextVerification: "verified",
  });
  core.setOutput("backup-asset-name", backup);
  core.setOutput("state-write-committed", true);
  core.setOutput("state-phase", "maintenance");
  try {
    writeRestoreReceipt(config, marker(authoritative));
    const backupCount = await retainBackups(
      context,
      await listAssets(octokit, config.target, release.id),
    );
    core.setOutput("backup-count", backupCount);
    core.setOutput("state-phase", "complete");
    core.setOutput("state-status", "success");
  } catch (error) {
    core.setOutput("state-status", "maintenance-failed");
    throw new Error(
      `State save committed and verified, but post-commit backup maintenance failed: ${
        error instanceof Error ? error.message : "unknown maintenance error"
      }. The emitted remote-state-marker identifies the authoritative new state; restore again before the next save and inspect backup retention separately.`,
      { cause: error },
    );
  }
}
