import { core } from "./action-core.mjs";
import {
  bundleAssets,
  isBackupAsset,
  type BundleAssets,
} from "./asset-names.mjs";
import { createBackup } from "./backup-manager.mjs";
import { failWithCode } from "./errors.mjs";
import {
  deleteAsset,
  deleteRelease,
  deleteTag,
  getRelease,
  listAssets,
} from "./github-api.mjs";
import { sha256 } from "./integrity.mjs";
import { marker } from "./marker.mjs";
import { writeRestoreReceipt } from "./receipt.mjs";
import {
  resetAssets,
  resetWithClient,
  type ResetClient,
  type ResetResult,
} from "./reset-core.mjs";
import {
  assertUploadedBundle,
  deleteBundleAssets,
  restorePreviousBundle,
  sameBundle,
  uploadCurrentBundle,
} from "./state-manager.mjs";
import {
  assertNoUnsupportedStorage,
  createBundleData,
  loadCompleteReleaseBundles,
  type LoadedStateBundle,
} from "./state-bundle.mjs";
import type { Release, StateManagerContext } from "./types.mjs";

function actionVersion(): string {
  return process.env.GITHUB_ACTION_REF || "unknown";
}

function assertOwnedNamespace(
  context: StateManagerContext,
  assets: Awaited<ReturnType<typeof listAssets>>,
): void {
  const { unexpected } = resetAssets(assets, context.config.assetName);
  if (unexpected.length > 0) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      `Refusing reset: release ${context.config.tag} contains non-state assets (${unexpected
        .map((asset) => asset.name)
        .join(", ")}).`,
    );
  }
}

function emitPromotionOutputs(result: ResetResult): void {
  core.setOutput("operation", "reset");
  core.setOutput("reset-deleted-asset-count", result.deletedAssetCount);
  core.setOutput("reset-release-found", result.releaseFound);
  core.setOutput("reset-action", result.action);
  core.setOutput("reset-target", result.target);
  if (result.promotedMarker) {
    core.setOutput("reset-promoted-marker", result.promotedMarker);
    core.setOutput("remote-state-marker", result.promotedMarker);
  }
  if (result.backupAssetName) {
    core.setOutput("backup-asset-name", result.backupAssetName);
  }
  core.setOutput("state-write-committed", true);
  core.setOutput("state-phase", "maintenance");
}

async function promoteBackup(
  context: StateManagerContext,
  release: Release,
): Promise<ResetResult> {
  const { config, octokit } = context;
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(config.resetTarget) ||
    !isBackupAsset(config.resetTarget, config.assetName)
  ) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      `reset-target must be all or an exact ${config.assetName}.backup-* state asset name.`,
    );
  }
  let assets = await listAssets(octokit, config.target, release.id);
  assertOwnedNamespace(context, assets);
  const loaded = await loadCompleteReleaseBundles(context, assets);
  const selected = loaded.get(config.resetTarget);
  if (!selected) {
    failWithCode(
      "TRS_OBJECT_NOT_FOUND",
      `Backup bundle ${config.resetTarget} does not exist or is incomplete.`,
    );
  }
  const previous = loaded.get(config.assetName);
  const observedCurrent = bundleAssets(assets, config.assetName);
  const observedTarget = bundleAssets(assets, config.resetTarget);
  if (!selected.plaintext) {
    failWithCode(
      "TRS_DECRYPTION_FAILED",
      `Backup ${config.resetTarget} must be decrypted and plaintext-verified before promotion.`,
    );
  }
  if (
    selected.signature.status === "verified" &&
    !config.signing?.privateKeyPem
  ) {
    failWithCode(
      "TRS_SIGNATURE_REQUIRED",
      `Promoting signed backup ${config.resetTarget} requires signing-private-key to sign the new current manifest.`,
    );
  }
  if (
    previous?.signature.status === "verified" &&
    !config.signing?.privateKeyPem
  ) {
    failWithCode(
      "TRS_SIGNATURE_REQUIRED",
      "signing-private-key is required to preserve the current signed state in the reset safety backup.",
    );
  }
  if (previous?.manifest?.encryption.mode === "age" && !previous.plaintext) {
    failWithCode(
      "TRS_DECRYPTION_FAILED",
      "age-identities is required to verify and preserve the current encrypted state in the reset safety backup.",
    );
  }
  let safetyBackup = "";
  if (previous?.assets.state) {
    safetyBackup = await createBackup(
      context,
      release,
      previous.assets.state,
      previous,
    );
  }

  assets = await listAssets(octokit, config.target, release.id);
  assertOwnedNamespace(context, assets);
  if (
    !sameBundle(observedCurrent, bundleAssets(assets, config.assetName)) ||
    !sameBundle(observedTarget, bundleAssets(assets, config.resetTarget))
  ) {
    failWithCode(
      "TRS_REMOTE_CHANGED",
      "Current state or selected backup changed during reset preparation; refusing promotion.",
    );
  }

  const parentMarker = previous?.assets.state
    ? marker(previous.assets.state)
    : null;
  const selectedEncryption = selected.manifest?.encryption;
  const currentData = createBundleData(
    {
      role: "current",
      name: config.assetName,
      stored: selected.stored,
      plaintext: selected.plaintext,
      encryptionMode: selectedEncryption?.mode || "none",
      encryptionKeyFingerprint: selectedEncryption?.key_fingerprint || null,
      parentMarker,
      parentStoredSha256: previous ? sha256(previous.stored) : null,
      sourceCommit: config.sourceCommit,
      workflowRunId: config.workflowRunId,
      actionVersion: actionVersion(),
    },
    context,
  );

  const replacement: BundleAssets = {};
  let authoritative: LoadedStateBundle;
  try {
    await deleteBundleAssets(context, observedCurrent);
    await uploadCurrentBundle(context, release, currentData, replacement);
    authoritative = (
      await assertUploadedBundle(context, release, replacement, currentData)
    ).loaded;
  } catch (error) {
    try {
      await restorePreviousBundle(context, release, previous, replacement);
    } catch (recoveryError) {
      throw new Error(
        `Backup promotion failed and automatic recovery could not complete: ${
          recoveryError instanceof Error
            ? recoveryError.message
            : "unknown recovery error"
        }`,
        { cause: error },
      );
    }
    throw error;
  }

  const current = authoritative.assets.state;
  if (!current) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      "Verified promoted current bundle does not contain its state asset.",
    );
  }
  const result: ResetResult = {
    deletedAssetCount: 0,
    releaseFound: true,
    action: "promoted",
    target: config.resetTarget,
    promotedMarker: marker(current),
    backupAssetName: safetyBackup || undefined,
  };
  emitPromotionOutputs(result);
  try {
    writeRestoreReceipt(config, result.promotedMarker as string);
    core.setOutput("state-phase", "complete");
    core.setOutput("state-status", "success");
  } catch (error) {
    core.setOutput("state-status", "maintenance-failed");
    throw new Error(
      `Backup ${config.resetTarget} was promoted and verified, but the local restore receipt could not be updated. The emitted remote-state-marker identifies the authoritative current state; run restore before save.`,
      { cause: error },
    );
  }
  return result;
}

export async function reset(
  context: StateManagerContext,
): Promise<ResetResult> {
  const client: ResetClient = {
    getRelease: (target, tag) => getRelease(context.octokit, target, tag),
    listAssets: (target, releaseId) =>
      listAssets(context.octokit, target, releaseId),
    deleteAsset: (target, assetId) =>
      deleteAsset(context.octokit, target, assetId),
    deleteRelease: (target, releaseId) =>
      deleteRelease(context.octokit, target, releaseId),
    deleteTag: (target, tag) => deleteTag(context.octokit, target, tag),
    beforeDelete: (assets) => assertNoUnsupportedStorage(context, assets),
  };
  if (context.config.resetTarget === "all") {
    return resetWithClient(context, client);
  }
  const release = await getRelease(
    context.octokit,
    context.config.target,
    context.config.tag,
  );
  if (!release) {
    failWithCode(
      "TRS_OBJECT_NOT_FOUND",
      `State release ${context.config.tag} does not exist; backup ${context.config.resetTarget} cannot be promoted.`,
    );
  }
  return promoteBackup(context, release);
}
