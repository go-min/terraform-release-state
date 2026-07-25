import {
  deleteAsset,
  deleteRelease,
  deleteTag,
  getRelease,
  listAssets,
} from "./github-api.mjs";
import {
  resetWithClient,
  type ResetClient,
  type ResetResult,
} from "./reset-core.mjs";
import type { StateManagerContext } from "./types.mjs";

export {
  RESET_CONFIRMATION,
  isResetAsset,
  resetAssets,
  validateResetConfirmation,
} from "./reset-core.mjs";
export type { ResetClient, ResetResult } from "./reset-core.mjs";

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
  };
  return resetWithClient(context, client);
}
