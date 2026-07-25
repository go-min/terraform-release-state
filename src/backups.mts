const METADATA_SUFFIX = ".metadata.json";

export function isBackupAsset(assetName: string, stateAssetName: string): boolean {
  return (
    assetName.startsWith(`${stateAssetName}.backup-`) &&
    !assetName.includes(".metadata.")
  );
}

export function metadataAssetNames(backupName: string): string[] {
  return [`${backupName}${METADATA_SUFFIX}`];
}
