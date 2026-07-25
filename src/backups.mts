const METADATA_SUFFIX = ".metadata.json";

export function isBackupAsset(
  assetName: string,
  stateAssetName: string,
): boolean {
  return (
    assetName.startsWith(`${stateAssetName}.backup-`) &&
    !assetName.endsWith(".metadata.json")
  );
}

export function metadataAssetNames(backupName: string): string[] {
  return [`${backupName}${METADATA_SUFFIX}`];
}
