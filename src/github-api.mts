import { createHash } from "node:crypto";
import type { Asset, Octokit, Release, RepositoryTarget } from "./types.mjs";

function fail(message: string): never {
  throw new Error(message);
}

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!status || !RETRYABLE_STATUSES.has(status) || attempt >= 4) {
        throw error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 500 * 2 ** attempt),
      );
    }
  }
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function assetDigest(asset: Asset): string {
  return ((asset as Asset & { digest?: string }).digest || "").replace(
    /^sha256:/,
    "",
  );
}

export async function getRelease(
  octokit: Octokit,
  target: RepositoryTarget,
  tag: string,
): Promise<Release | undefined> {
  try {
    const response = await retry(() =>
      octokit.rest.repos.getReleaseByTag({ ...target, tag }),
    );
    return response.data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}

export async function createRelease(
  octokit: Octokit,
  target: RepositoryTarget,
  tag: string,
): Promise<Release> {
  try {
    const response = await octokit.rest.repos.createRelease({
      ...target,
      tag_name: tag,
      name: "Terraform state",
      body: "Service release for Terraform state; do not delete.",
      draft: false,
      prerelease: false,
    });
    return response.data;
  } catch (error) {
    const existing = await getRelease(octokit, target, tag);
    if (existing) return existing;
    throw error;
  }
}

export async function listAssets(
  octokit: Octokit,
  target: RepositoryTarget,
  releaseId: number,
): Promise<Asset[]> {
  return retry(() =>
    octokit.paginate(octokit.rest.repos.listReleaseAssets, {
      ...target,
      release_id: releaseId,
      per_page: 100,
    }),
  ) as Promise<Asset[]>;
}

export function findAsset(items: Asset[], name: string): Asset | undefined {
  const matches = items.filter(
    (asset) => asset.name === name && asset.state === "uploaded",
  );
  if (matches.length > 1) {
    fail(`Release contains duplicate assets named ${name}.`);
  }
  return matches[0];
}

export async function downloadAsset(
  octokit: Octokit,
  target: RepositoryTarget,
  asset: Asset,
): Promise<Buffer> {
  const response = await retry(() =>
    octokit.request("GET /repos/{owner}/{repo}/releases/assets/{asset_id}", {
      ...target,
      asset_id: asset.id,
      headers: { accept: "application/octet-stream" },
      request: { responseType: "arraybuffer" },
    }),
  );
  const raw = response.data as unknown as ArrayBuffer | Buffer;
  const data = Buffer.isBuffer(raw) ? raw : Buffer.from(raw);
  if (data.length === 0) fail(`State asset ${asset.name} is empty.`);
  if (assetDigest(asset) && assetDigest(asset) !== sha256(data)) {
    fail(`Integrity check failed for asset ${asset.name}.`);
  }
  return data;
}

export async function uploadAsset(
  octokit: Octokit,
  target: RepositoryTarget,
  releaseId: number,
  name: string,
  data: Buffer,
  contentType = "application/octet-stream",
): Promise<Asset> {
  try {
    const response = await octokit.rest.repos.uploadReleaseAsset({
      ...target,
      release_id: releaseId,
      name,
      data: data as unknown as string,
      headers: { "content-type": contentType, "content-length": data.length },
    });
    return response.data;
  } catch (error) {
    const existing = findAsset(
      await listAssets(octokit, target, releaseId),
      name,
    );
    if (!existing) throw error;
    const existingData = await downloadAsset(octokit, target, existing);
    if (sha256(existingData) !== sha256(data)) {
      fail(`Release asset ${name} already exists with unexpected content.`);
    }
    return existing;
  }
}

export async function deleteAsset(
  octokit: Octokit,
  target: RepositoryTarget,
  assetId: number,
): Promise<void> {
  try {
    await retry(() =>
      octokit.rest.repos.deleteReleaseAsset({ ...target, asset_id: assetId }),
    );
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
}

export async function deleteRelease(
  octokit: Octokit,
  target: RepositoryTarget,
  releaseId: number,
): Promise<void> {
  try {
    await retry(() =>
      octokit.rest.repos.deleteRelease({ ...target, release_id: releaseId }),
    );
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
}

export async function deleteTag(
  octokit: Octokit,
  target: RepositoryTarget,
  tag: string,
): Promise<void> {
  try {
    await retry(() =>
      octokit.rest.git.deleteRef({ ...target, ref: `tags/${tag}` }),
    );
  } catch (error) {
    if ((error as { status?: number }).status !== 404) throw error;
  }
}
