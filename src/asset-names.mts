import { randomUUID } from "node:crypto";
import { failWithCode } from "./errors.mjs";
import type { Asset } from "./types.mjs";

const METADATA_SUFFIX = ".metadata.json";
const MANIFEST_SUFFIX = ".manifest.json";
const SIGNATURE_SUFFIX = ".manifest.sig.json";

export type BundleAssetKind = "state" | "metadata" | "manifest" | "signature";

export type BundleAssets = {
  state?: Asset;
  metadata?: Asset;
  manifest?: Asset;
  signature?: Asset;
};

export function metadataName(assetName: string): string {
  return `${assetName}${METADATA_SUFFIX}`;
}

export function manifestName(assetName: string): string {
  return `${assetName}${MANIFEST_SUFFIX}`;
}

export function signatureName(assetName: string): string {
  return `${assetName}${SIGNATURE_SUFFIX}`;
}

export function bundleNames(
  assetName: string,
): Record<BundleAssetKind, string> {
  return {
    state: assetName,
    metadata: metadataName(assetName),
    manifest: manifestName(assetName),
    signature: signatureName(assetName),
  };
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
    !assetName.endsWith(METADATA_SUFFIX) &&
    !assetName.endsWith(MANIFEST_SUFFIX) &&
    !assetName.endsWith(SIGNATURE_SUFFIX)
  );
}

export function backupObjectName(
  assetName: string,
  stateAssetName: string,
): string | undefined {
  const suffix = [SIGNATURE_SUFFIX, MANIFEST_SUFFIX, METADATA_SUFFIX].find(
    (candidate) => assetName.endsWith(candidate),
  );
  const objectName = suffix ? assetName.slice(0, -suffix.length) : assetName;
  return isBackupAsset(objectName, stateAssetName) ? objectName : undefined;
}

export function bundleAssets(
  assets: Asset[],
  objectName: string,
): BundleAssets {
  const names = bundleNames(objectName);
  const result: BundleAssets = {};
  for (const [kind, name] of Object.entries(names) as Array<
    [BundleAssetKind, string]
  >) {
    const matches = assets.filter(
      (asset) => asset.state === "uploaded" && asset.name === name,
    );
    if (matches.length > 1) {
      failWithCode(
        "TRS_OBJECT_SET_INCOMPLETE",
        `Release contains duplicate assets named ${name}.`,
      );
    }
    result[kind] = matches[0];
  }
  return result;
}

export function backupBundleNames(
  assets: Asset[],
  stateAssetName: string,
): string[] {
  return [
    ...new Set(
      assets
        .filter((asset) => asset.state === "uploaded")
        .map((asset) => backupObjectName(asset.name, stateAssetName))
        .filter((name): name is string => Boolean(name)),
    ),
  ].sort();
}

export function createBackupName(assetName: string, runId: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.([0-9]{3})Z$/, "$1Z");
  const source = runId || process.env.GITHUB_RUN_ID || "local";
  return `${assetName}.backup-${timestamp}-${source}-${randomUUID()}`;
}
