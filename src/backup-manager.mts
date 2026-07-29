import {
  backupBundleNames,
  bundleAssets,
  createBackupName,
  manifestName,
  metadataName,
  type BundleAssets,
} from "./asset-names.mjs";
import { failWithCode } from "./errors.mjs";
import {
  deleteAsset,
  downloadAsset,
  listAssets,
  uploadAsset,
} from "./github-api.mjs";
import { sha256 } from "./integrity.mjs";
import { marker } from "./marker.mjs";
import {
  compatibilityBackupMetadata,
  createBundleData,
  createBundleDataFromManifest,
  loadStateBundle,
  type BundleData,
  type LoadedStateBundle,
} from "./state-bundle.mjs";
import type { Asset, Release, StateManagerContext } from "./types.mjs";

function actionVersion(): string {
  return process.env.GITHUB_ACTION_REF || "unknown";
}

async function backupBundleData(
  context: StateManagerContext,
  current: Asset,
  previous: LoadedStateBundle,
  name: string,
  createdAt: string,
): Promise<BundleData> {
  const { config } = context;
  if (previous.manifest) {
    const metadata = compatibilityBackupMetadata({
      stored: previous.stored,
      currentAsset: current.name,
      sourceCommit: config.sourceCommit,
      workflowRunId: config.workflowRunId,
      actionVersion: actionVersion(),
      createdAt,
    });
    return createBundleDataFromManifest(
      {
        ...previous.manifest,
        object: { role: "backup", name },
        parent: {
          remote_state_marker: marker(current),
          stored_sha256: previous.manifest.content.stored.sha256,
        },
        provenance: {
          source_commit: config.sourceCommit || "unknown",
          workflow_run_id: config.workflowRunId || "unknown",
          action_version: actionVersion(),
          created_at: createdAt,
        },
      },
      previous.stored,
      metadata,
    );
  }
  if (!previous.plaintext) {
    failWithCode(
      "TRS_OBJECT_SET_INCOMPLETE",
      "Legacy state must be available as verified plaintext before backup creation.",
    );
  }
  const stored = previous.stored;
  const metadata = compatibilityBackupMetadata({
    stored,
    currentAsset: current.name,
    sourceCommit: config.sourceCommit,
    workflowRunId: config.workflowRunId,
    actionVersion: actionVersion(),
    createdAt,
  });
  return createBundleData(
    {
      role: "backup",
      name,
      stored,
      plaintext: previous.plaintext,
      encryptionMode: "none",
      encryptionKeyFingerprint: null,
      parentMarker: marker(current),
      parentStoredSha256: sha256(previous.stored),
      sourceCommit: config.sourceCommit,
      workflowRunId: config.workflowRunId,
      actionVersion: actionVersion(),
      createdAt,
    },
    metadata,
  );
}

async function uploadBundle(
  context: StateManagerContext,
  release: Release,
  name: string,
  data: BundleData,
): Promise<BundleAssets> {
  const { octokit, config } = context;
  const uploaded: BundleAssets = {};
  uploaded.state = await uploadAsset(
    octokit,
    config.target,
    release.id,
    name,
    data.state,
  );
  if (data.metadata) {
    uploaded.metadata = await uploadAsset(
      octokit,
      config.target,
      release.id,
      metadataName(name),
      data.metadata,
      "application/json",
    );
  }
  // The manifest is uploaded last and acts as the flat-bundle completion
  // signal.
  uploaded.manifest = await uploadAsset(
    octokit,
    config.target,
    release.id,
    manifestName(name),
    data.manifest,
    "application/json",
  );
  return uploaded;
}

async function deleteBundle(
  context: StateManagerContext,
  assets: BundleAssets,
): Promise<void> {
  for (const asset of [
    assets.signature,
    assets.manifest,
    assets.metadata,
    assets.state,
  ]) {
    if (asset)
      await deleteAsset(context.octokit, context.config.target, asset.id);
  }
}

async function assertUploadedBytes(
  context: StateManagerContext,
  uploaded: BundleAssets,
  expected: BundleData,
): Promise<void> {
  const entries: Array<[Asset | undefined, Buffer | undefined, string]> = [
    [uploaded.state, expected.state, "state"],
    [uploaded.metadata, expected.metadata, "metadata"],
    [uploaded.manifest, expected.manifest, "manifest"],
  ];
  for (const [asset, data, kind] of entries) {
    if (!asset || !data) {
      if (asset || data) {
        failWithCode(
          "TRS_OBJECT_SET_INCOMPLETE",
          `Uploaded backup ${kind} object is incomplete.`,
        );
      }
      continue;
    }
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
        `Uploaded backup ${kind} asset ${asset.name} failed checksum verification.`,
      );
    }
  }
}

export async function createBackup(
  context: StateManagerContext,
  release: Release,
  current: Asset,
  previous: LoadedStateBundle,
): Promise<string> {
  const name = createBackupName(
    context.config.assetName,
    context.config.workflowRunId,
  );
  const createdAt = new Date().toISOString();
  const data = await backupBundleData(
    context,
    current,
    previous,
    name,
    createdAt,
  );
  let uploaded: BundleAssets = {};
  try {
    uploaded = await uploadBundle(context, release, name, data);
    await assertUploadedBytes(context, uploaded, data);
    const assets = await listAssets(
      context.octokit,
      context.config.target,
      release.id,
    );
    const listed = bundleAssets(assets, name);
    for (const kind of [
      "state",
      "metadata",
      "manifest",
      "signature",
    ] as const) {
      if (uploaded[kind]?.id !== listed[kind]?.id) {
        if (uploaded[kind] || listed[kind]) {
          failWithCode(
            "TRS_REMOTE_CHANGED",
            `Backup bundle ${name} changed during upload verification.`,
          );
        }
      }
    }
    await loadStateBundle(context, assets, name, "backup", {
      plaintext: "if-available",
    });
  } catch (error) {
    try {
      const assets = await listAssets(
        context.octokit,
        context.config.target,
        release.id,
      );
      const listed = bundleAssets(assets, name);
      await deleteBundle(context, {
        state: listed.state || uploaded.state,
        metadata: listed.metadata || uploaded.metadata,
        manifest: listed.manifest || uploaded.manifest,
        signature: listed.signature || uploaded.signature,
      });
    } catch (cleanupError) {
      throw new Error(
        `Backup bundle creation failed and compensating cleanup could not complete: ${errorMessage(cleanupError)}`,
        { cause: error },
      );
    }
    throw error;
  }
  return name;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "unknown cleanup error";
}

function completeBundle(bundle: BundleAssets): boolean {
  if (!bundle.state || !bundle.metadata) return false;
  if (bundle.signature && !bundle.manifest) return false;
  return true;
}

export async function retainBackups(
  context: StateManagerContext,
  assets: Asset[],
): Promise<number> {
  const names = backupBundleNames(assets, context.config.assetName);
  const complete: BundleAssets[] = [];
  for (const name of names) {
    const bundle = bundleAssets(assets, name);
    if (completeBundle(bundle)) complete.push(bundle);
    else await deleteBundle(context, bundle);
  }
  complete.sort((left, right) => {
    const leftState = left.state as Asset;
    const rightState = right.state as Asset;
    const createdDifference =
      Date.parse(rightState.created_at) - Date.parse(leftState.created_at);
    return createdDifference || rightState.id - leftState.id;
  });
  for (const bundle of complete.slice(context.config.backupRetention)) {
    await deleteBundle(context, bundle);
  }
  return Math.min(complete.length, context.config.backupRetention);
}
