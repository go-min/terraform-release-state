import { randomUUID } from "node:crypto";

const METADATA_SUFFIX = ".metadata.json";

export function metadataName(assetName: string): string {
  return `${assetName}${METADATA_SUFFIX}`;
}

export function backupNameFromMetadata(
  assetName: string,
  stateAssetName: string,
): string | undefined {
  if (!assetName.endsWith(METADATA_SUFFIX)) return undefined;
  const backupName = assetName.slice(0, -METADATA_SUFFIX.length);
  return isBackupAsset(backupName, stateAssetName) ? backupName : undefined;
}

export function isBackupAsset(
  assetName: string,
  stateAssetName: string,
): boolean {
  return (
    assetName.startsWith(`${stateAssetName}.backup-`) &&
    !assetName.endsWith(METADATA_SUFFIX)
  );
}

export function createBackupName(assetName: string, runId: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.([0-9]{3})Z$/, "$1Z");
  const source = runId || process.env.GITHUB_RUN_ID || "local";
  return `${assetName}.backup-${timestamp}-${source}-${randomUUID()}`;
}
