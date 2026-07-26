import {
  backupNameFromMetadata,
  createBackupName,
  isBackupAsset,
  metadataName,
} from "./asset-names.mjs";
import {
  deleteAsset,
  findAsset,
  listAssets,
  uploadAsset,
} from "./github-api.mjs";
import { sha256 } from "./integrity.mjs";
import type { Asset, Release, StateManagerContext } from "./types.mjs";

export async function createBackup(
  context: StateManagerContext,
  release: Release,
  current: Asset,
  previous: Buffer,
): Promise<string> {
  const { octokit, config } = context;
  const name = createBackupName(config.assetName, config.workflowRunId);
  const metadata = Buffer.from(
    `${JSON.stringify(
      {
        timestamp_utc: new Date().toISOString(),
        source_commit:
          config.sourceCommit || process.env.GITHUB_SHA || "unknown",
        workflow_run_id:
          config.workflowRunId || process.env.GITHUB_RUN_ID || "unknown",
        action_version: process.env.GITHUB_ACTION_REF || "unknown",
        current_asset: current.name,
        encryption: config.encryption.mode,
        sha256: sha256(previous),
      },
      null,
      2,
    )}\n`,
  );
  const backup = await uploadAsset(
    octokit,
    config.target,
    release.id,
    name,
    previous,
  );
  try {
    await uploadAsset(
      octokit,
      config.target,
      release.id,
      metadataName(name),
      metadata,
      "application/json",
    );
  } catch (error) {
    try {
      const assets = await listAssets(octokit, config.target, release.id);
      const uploadedMetadata = findAsset(assets, metadataName(name));
      if (uploadedMetadata) {
        await deleteAsset(octokit, config.target, uploadedMetadata.id);
      }
      await deleteAsset(octokit, config.target, backup.id);
    } catch (cleanupError) {
      throw new Error(
        `Backup metadata upload failed and compensating cleanup could not complete: ${errorMessage(cleanupError)}`,
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

export async function retainBackups(
  context: StateManagerContext,
  assets: Asset[],
): Promise<number> {
  const { octokit, config } = context;
  const uploaded = assets.filter((asset) => asset.state === "uploaded");
  const backups = uploaded
    .filter((asset) => isBackupAsset(asset.name, config.assetName))
    .sort((left, right) => {
      const createdDifference =
        Date.parse(right.created_at) - Date.parse(left.created_at);
      return createdDifference || right.id - left.id;
    });

  const backupNames = new Set(backups.map((asset) => asset.name));
  const metadataByBackup = new Map<string, Asset>();
  for (const asset of uploaded) {
    const backupName = backupNameFromMetadata(asset.name, config.assetName);
    if (!backupName) continue;
    if (metadataByBackup.has(backupName)) {
      throw new Error(
        `Release contains duplicate metadata assets for ${backupName}.`,
      );
    }
    metadataByBackup.set(backupName, asset);
  }

  for (const [backupName, metadata] of metadataByBackup) {
    if (!backupNames.has(backupName)) {
      await deleteAsset(octokit, config.target, metadata.id);
    }
  }

  const completeBackups: Asset[] = [];
  for (const backup of backups) {
    if (metadataByBackup.has(backup.name)) completeBackups.push(backup);
    else await deleteAsset(octokit, config.target, backup.id);
  }

  for (const backup of completeBackups.slice(config.backupRetention)) {
    const metadata = metadataByBackup.get(backup.name);
    if (metadata) await deleteAsset(octokit, config.target, metadata.id);
    await deleteAsset(octokit, config.target, backup.id);
  }
  return Math.min(completeBackups.length, config.backupRetention);
}
