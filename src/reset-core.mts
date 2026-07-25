import type {
  Asset,
  Release,
  RepositoryTarget,
  StateManagerContext,
} from "./types.mjs";
import { metadataName } from "./asset-names.mjs";

export const RESET_CONFIRMATION = "RESET";

export function validateResetConfirmation(value: string): void {
  if (value !== RESET_CONFIRMATION) {
    throw new Error(
      `reset requires confirmation=${RESET_CONFIRMATION}; no state resources were changed.`,
    );
  }
}

export function isResetAsset(
  assetName: string,
  stateAssetName: string,
): boolean {
  return (
    assetName === stateAssetName ||
    assetName === metadataName(stateAssetName) ||
    assetName.startsWith(`${stateAssetName}.backup-`)
  );
}

export function resetAssets(
  assets: Asset[],
  stateAssetName: string,
): { owned: Asset[]; unexpected: Asset[] } {
  const owned = assets.filter((asset) =>
    isResetAsset(asset.name, stateAssetName),
  );
  return {
    owned,
    unexpected: assets.filter(
      (asset) => !isResetAsset(asset.name, stateAssetName),
    ),
  };
}

export type ResetClient = {
  getRelease: (
    target: RepositoryTarget,
    tag: string,
  ) => Promise<Release | undefined>;
  listAssets: (target: RepositoryTarget, releaseId: number) => Promise<Asset[]>;
  deleteAsset: (target: RepositoryTarget, assetId: number) => Promise<void>;
  deleteRelease: (target: RepositoryTarget, releaseId: number) => Promise<void>;
  deleteTag: (target: RepositoryTarget, tag: string) => Promise<void>;
};

export type ResetResult = {
  deletedAssetCount: number;
  releaseFound: boolean;
};

export async function resetWithClient(
  context: StateManagerContext,
  client: ResetClient,
): Promise<ResetResult> {
  const { config } = context;
  validateResetConfirmation(config.resetConfirmation);

  const release = await client.getRelease(config.target, config.tag);
  if (!release) {
    await client.deleteTag(config.target, config.tag);
    return { deletedAssetCount: 0, releaseFound: false };
  }

  const assets = await client.listAssets(config.target, release.id);
  const { owned, unexpected } = resetAssets(assets, config.assetName);
  if (unexpected.length > 0) {
    throw new Error(
      `Refusing reset: release ${config.tag} contains non-state assets (${unexpected
        .map((asset) => asset.name)
        .join(", ")}).`,
    );
  }

  for (const asset of owned) {
    await client.deleteAsset(config.target, asset.id);
  }
  const remaining = await client.listAssets(config.target, release.id);
  if (remaining.length > 0) {
    throw new Error(
      `Refusing reset: release ${config.tag} changed during reset; no release or tag was deleted.`,
    );
  }
  await client.deleteRelease(config.target, release.id);
  await client.deleteTag(config.target, config.tag);
  return { deletedAssetCount: owned.length, releaseFound: true };
}
