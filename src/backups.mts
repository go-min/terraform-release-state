const LEGACY_METADATA_SUFFIX = ".metadata.txt";
const METADATA_SUFFIX = ".metadata.json";

export function isBackupAsset(assetName: string, stateAssetName: string): boolean {
  return (
    assetName.startsWith(`${stateAssetName}.backup-`) &&
    !assetName.endsWith(LEGACY_METADATA_SUFFIX) &&
    !assetName.endsWith(METADATA_SUFFIX)
  );
}

export function metadataAssetNames(backupName: string): string[] {
  return [`${backupName}${METADATA_SUFFIX}`, `${backupName}${LEGACY_METADATA_SUFFIX}`];
}
