import { existsSync } from "node:fs";
import { core, fail } from "./action-core.mjs";
import {
  currentMetadataName,
  isBackupAsset,
  metadataAssetNames,
} from "./backups.mjs";
import { backupName } from "./backup-names.mjs";
import { decryptState, encryptState } from "./encryption.mjs";
import {
  createRelease,
  deleteAsset,
  downloadAsset,
  findAsset,
  getRelease,
  listAssets,
  uploadAsset,
} from "./github-api.mjs";
import {
  decodeMarker,
  marker,
  sameAssetMarker,
  sameMarker,
  sha256,
} from "./marker.mjs";
import { createStateMetadata, parseStateMetadata } from "./state-metadata.mjs";
import { readStateFile, writeStateFile } from "./state-files.mjs";
import type { Asset, Release, StateManagerContext } from "./types.mjs";

type CurrentMetadata = {
  asset: Asset;
  data: Buffer;
};

function emitOutputs(
  operation: string,
  release: Release,
  asset: Asset | undefined,
  data: Buffer | undefined,
  bootstrapped = false,
): void {
  core.setOutput("operation", operation);
  core.setOutput("release-id", release.id);
  core.setOutput("bootstrapped", bootstrapped);
  core.setOutput("remote-state-marker", marker(asset));
  if (asset) {
    core.setOutput("state-asset-id", asset.id);
    core.setOutput(
      "state-digest",
      ((asset as Asset & { digest?: string }).digest || "").replace(
        /^sha256:/,
        "",
      ),
    );
  }
  if (data) core.setOutput("state-sha256", sha256(data));
}

async function ensureRelease(
  context: StateManagerContext,
): Promise<{ release: Release; created: boolean }> {
  const { octokit, config } = context;
  const existing = await getRelease(octokit, config.target, config.tag);
  if (existing) return { release: existing, created: false };
  if (!config.bootstrap) {
    fail(
      `State release ${config.tag} does not exist; set bootstrap=true explicitly.`,
    );
  }
  return {
    release: await createRelease(octokit, config.target, config.tag),
    created: true,
  };
}

async function loadCurrentMetadata(
  context: StateManagerContext,
  assets: Asset[],
  ciphertext: Buffer,
): Promise<CurrentMetadata | undefined> {
  const { octokit, config } = context;
  const asset = findAsset(assets, currentMetadataName(config.assetName));
  if (!asset) {
    if (config.encryption.mode === "age") {
      fail("Encrypted state is missing current state metadata.");
    }
    if (
      ciphertext.subarray(0, 22).toString("utf8") === "age-encryption.org/v1\n"
    ) {
      fail(
        "State asset appears encrypted but current state metadata is missing.",
      );
    }
    return undefined;
  }
  const data = await downloadAsset(octokit, config.target, asset);
  parseStateMetadata(data, config.encryption.mode, ciphertext);
  return { asset, data };
}

export async function restore(context: StateManagerContext): Promise<void> {
  const { octokit, config } = context;
  const { release } = await ensureRelease(context);
  const assets = await listAssets(octokit, config.target, release.id);
  const asset = findAsset(assets, config.assetName);
  if (!asset) {
    if (!config.bootstrap) {
      fail(
        `State asset ${config.assetName} is missing from release ${config.tag}.`,
      );
    }
    if (existsSync(config.statePath)) {
      fail(
        `State asset is missing but local state already exists at ${config.statePath}.`,
      );
    }
    core.setOutput("operation", "restore");
    core.setOutput("release-id", release.id);
    core.setOutput("bootstrapped", true);
    core.setOutput("remote-state-marker", "absent");
    return;
  }
  const ciphertext = await downloadAsset(octokit, config.target, asset);
  await loadCurrentMetadata(context, assets, ciphertext);
  const plaintext = await decryptState(config.encryption, ciphertext);
  writeStateFile(config.statePath, config.workspace, plaintext);
  emitOutputs("restore", release, asset, plaintext);
}

async function createBackup(
  context: StateManagerContext,
  release: Release,
  current: Asset,
  previous: Buffer,
): Promise<string> {
  const { octokit, config } = context;
  const name = backupName(config.assetName, config.workflowRunId);
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
  await uploadAsset(octokit, config.target, release.id, name, previous);
  await uploadAsset(
    octokit,
    config.target,
    release.id,
    `${name}.metadata.json`,
    metadata,
    "application/json",
  );
  return name;
}

async function retainBackups(
  context: StateManagerContext,
  assets: Asset[],
): Promise<number> {
  const { octokit, config } = context;
  const backups = assets
    .filter(
      (asset) =>
        asset.state === "uploaded" &&
        isBackupAsset(asset.name, config.assetName),
    )
    .sort(
      (left, right) =>
        Date.parse(right.created_at) - Date.parse(left.created_at),
    );
  for (const backup of backups.slice(config.backupRetention)) {
    await deleteAsset(octokit, config.target, backup.id);
    for (const metadataName of metadataAssetNames(backup.name)) {
      const metadata = assets.find((asset) => asset.name === metadataName);
      if (metadata) await deleteAsset(octokit, config.target, metadata.id);
    }
  }
  return Math.min(backups.length, config.backupRetention);
}

async function recoverPreviousState(
  context: StateManagerContext,
  release: Release,
  previousAsset: Asset | undefined,
  previous: Buffer | undefined,
  previousMetadata: CurrentMetadata | undefined,
  replacement: Asset | undefined,
  replacementMetadata: Asset | undefined,
): Promise<void> {
  const { octokit, config } = context;
  const assets = await listAssets(octokit, config.target, release.id);
  const current = findAsset(assets, config.assetName);
  const metadata = findAsset(assets, currentMetadataName(config.assetName));
  if (
    current &&
    previousAsset &&
    current.id === previousAsset.id &&
    ((!metadata && !previousMetadata) ||
      metadata?.id === previousMetadata?.asset.id)
  ) {
    return;
  }
  if (current) {
    if (!replacement || current.id !== replacement.id) {
      fail("Remote state changed during recovery; refusing to overwrite it.");
    }
    await deleteAsset(octokit, config.target, current.id);
  }
  if (metadata) {
    const knownMetadata =
      metadata.id === replacementMetadata?.id ||
      metadata.id === previousMetadata?.asset.id;
    if (!knownMetadata) {
      fail(
        "Remote state metadata changed during recovery; refusing to overwrite it.",
      );
    }
    await deleteAsset(octokit, config.target, metadata.id);
  }
  if (previous) {
    await uploadAsset(
      octokit,
      config.target,
      release.id,
      config.assetName,
      previous,
    );
  }
  if (previousMetadata) {
    await uploadAsset(
      octokit,
      config.target,
      release.id,
      currentMetadataName(config.assetName),
      previousMetadata.data,
      "application/json",
    );
  }
}

export async function save(context: StateManagerContext): Promise<void> {
  const { octokit, config } = context;
  if (!existsSync(config.statePath)) {
    fail(`State file not found: ${config.statePath}`);
  }
  const plaintext = readStateFile(config.statePath, config.workspace);
  if (!plaintext.length) fail(`State file is empty: ${config.statePath}`);
  const data = await encryptState(config.encryption, plaintext);
  const expected = config.expectedMarker
    ? decodeMarker(config.expectedMarker)
    : undefined;
  const { release } = await ensureRelease(context);
  let assets = await listAssets(octokit, config.target, release.id);
  let current = findAsset(assets, config.assetName);
  const previousAsset = current;

  if (!expected && current) {
    fail(
      "save requires expected-remote-state-marker from restore when current state exists.",
    );
  }
  if (expected === "absent" && current) {
    fail("Remote state appeared after restore; refusing to overwrite it.");
  }
  if (
    expected &&
    expected !== "absent" &&
    (!current || !sameMarker(expected, current))
  ) {
    fail("Remote state changed after restore; refusing to overwrite it.");
  }
  if (!current && expected && expected !== "absent") {
    fail("Remote state disappeared after restore; refusing to recreate it.");
  }
  if (!current && !config.bootstrap && expected !== "absent") {
    fail("Current state is missing; refusing implicit bootstrap.");
  }

  const bootstrapped = !current && config.bootstrap;
  const previous = current
    ? await downloadAsset(octokit, config.target, current)
    : undefined;
  const previousMetadata = current
    ? await loadCurrentMetadata(context, assets, previous as Buffer)
    : undefined;
  const backup = current
    ? await createBackup(context, release, current, previous as Buffer)
    : "";

  assets = await listAssets(octokit, config.target, release.id);
  const latest = findAsset(assets, config.assetName);
  const latestMetadata = findAsset(
    assets,
    currentMetadataName(config.assetName),
  );
  if (current && (!latest || !sameAssetMarker(current, latest))) {
    fail("Remote state changed during save; refusing to overwrite it.");
  }
  if (
    previousMetadata &&
    (!latestMetadata ||
      !sameAssetMarker(previousMetadata.asset, latestMetadata))
  ) {
    fail(
      "Remote state metadata changed during save; refusing to overwrite it.",
    );
  }
  if (!previousMetadata && latestMetadata) {
    fail(
      "Remote state metadata appeared during save; refusing to overwrite it.",
    );
  }
  if (!current && latest) {
    fail("Remote state appeared during save; refusing to overwrite it.");
  }
  current = latest;

  let replacement: Asset | undefined;
  let replacementMetadata: Asset | undefined;
  try {
    if (current) await deleteAsset(octokit, config.target, current.id);
    if (latestMetadata) {
      await deleteAsset(octokit, config.target, latestMetadata.id);
    }
    replacement = await uploadAsset(
      octokit,
      config.target,
      release.id,
      config.assetName,
      data,
    );
    if (config.encryption.mode === "age") {
      replacementMetadata = await uploadAsset(
        octokit,
        config.target,
        release.id,
        currentMetadataName(config.assetName),
        createStateMetadata(data),
        "application/json",
      );
    }
    assets = await listAssets(octokit, config.target, release.id);
    current = findAsset(assets, config.assetName);
    const metadata = findAsset(assets, currentMetadataName(config.assetName));
    if (!current) {
      fail(`Uploaded state asset ${config.assetName} could not be found.`);
    }
    if (current.id !== replacement.id) {
      fail("Remote state changed during save; refusing to overwrite it.");
    }
    if (
      (config.encryption.mode === "age" &&
        (!metadata || metadata.id !== replacementMetadata?.id)) ||
      (config.encryption.mode === "none" && metadata)
    ) {
      fail("Uploaded state metadata could not be verified.");
    }
    const uploaded = await downloadAsset(octokit, config.target, current);
    if (sha256(uploaded) !== sha256(data)) {
      fail(
        `Uploaded state asset ${config.assetName} failed checksum verification.`,
      );
    }
    if (metadata) {
      const metadataData = await downloadAsset(
        octokit,
        config.target,
        metadata,
      );
      parseStateMetadata(metadataData, config.encryption.mode, uploaded);
    }
  } catch (error) {
    try {
      await recoverPreviousState(
        context,
        release,
        previousAsset,
        previous,
        previousMetadata,
        replacement,
        replacementMetadata,
      );
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
  const backupCount = await retainBackups(context, assets);
  emitOutputs("save", release, current, plaintext, bootstrapped);
  core.setOutput("backup-asset-name", backup);
  core.setOutput("backup-count", backupCount);
}
