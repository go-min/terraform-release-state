import { manifestName } from "./asset-names.mjs";
import { assetDigest, sha256 } from "./integrity.mjs";
import type { Asset, Octokit, Release, RepositoryTarget } from "./types.mjs";

function fail(message: string): never {
  throw new Error(message);
}

const RETRYABLE_STATUSES = new Set([408, 500, 502, 503, 504]);
const RETRYABLE_NETWORK_CODES = new Set([
  "EAI_AGAIN",
  "ECONNREFUSED",
  "ECONNRESET",
  "ENETUNREACH",
  "EPIPE",
  "ETIMEDOUT",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_HEADERS_TIMEOUT",
  "UND_ERR_SOCKET",
]);
const MAX_RETRY_ATTEMPTS = 4;
const MAX_RATE_LIMIT_DELAY_MS = 5 * 60 * 1000;

type ApiError = {
  code?: string;
  status?: number;
  cause?: { code?: string };
  response?: {
    data?: { message?: string };
    headers?: Record<string, string | number | undefined>;
  };
};

function header(error: ApiError, name: string): string {
  return String(error.response?.headers?.[name] ?? "");
}

function rateLimitDelay(error: ApiError, attempt: number): number | undefined {
  const retryAfterHeader = header(error, "retry-after");
  if (retryAfterHeader) {
    const retryAfter = Number(retryAfterHeader);
    if (Number.isFinite(retryAfter) && retryAfter >= 0) {
      return retryAfter * 1000;
    }
  }

  if (header(error, "x-ratelimit-remaining") === "0") {
    const reset = Number(header(error, "x-ratelimit-reset"));
    if (!Number.isFinite(reset)) return undefined;
    return Math.max(0, reset * 1000 - Date.now());
  }

  const message = error.response?.data?.message || "";
  if (error.status === 429 || /rate limit/i.test(message)) {
    return 60_000 * 2 ** attempt;
  }
  return undefined;
}

function retryDelay(error: unknown, attempt: number): number | undefined {
  const apiError = error as ApiError;
  const networkCode = apiError.code || apiError.cause?.code || "";
  if (
    RETRYABLE_STATUSES.has(apiError.status || 0) ||
    RETRYABLE_NETWORK_CODES.has(networkCode)
  ) {
    return 500 * 2 ** attempt;
  }
  if (apiError.status !== 403 && apiError.status !== 429) return undefined;
  const delay = rateLimitDelay(apiError, attempt);
  if (delay === undefined || delay > MAX_RATE_LIMIT_DELAY_MS) return undefined;
  return delay;
}

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const delay = retryDelay(error, attempt);
      if (delay === undefined || attempt >= MAX_RETRY_ATTEMPTS) throw error;
      await new Promise((resolveDelay) => setTimeout(resolveDelay, delay));
    }
  }
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

export function managedReleaseBody(
  target: RepositoryTarget,
  tag: string,
  assetName: string,
): string {
  const repository = `${target.owner}/${target.repo}`;
  const actionUrl = "https://github.com/go-min/terraform-release-state";
  return `> [!CAUTION]
> **Service release for Terraform state; do not delete.**
>
> Deleting or manually replacing this release or its assets can cause state loss and consistency failures.

## Managed state

- **Repository:** [\`${repository}\`](https://github.com/${repository})
- **Release tag:** \`${tag}\`
- **Current state:** \`${assetName}\`
- **State manifest:** \`${manifestName(assetName)}\`
- **Recovery backups:** \`${assetName}.backup-*\` with matching manifest and compatibility metadata assets

The current state asset and its manifest are authoritative. v0.5 stores only plaintext unsigned state and retains 20 verified backups. If the state asset is absent, protected bootstrap created this storage and it is awaiting its first save. The action validates asset integrity and refuses stale writes through an internal restore receipt.

Managed by [Terraform Release State](${actionUrl}). See the [documentation](${actionUrl}#readme) and [recovery guide](${actionUrl}/blob/main/docs/recovery.md) before changing any asset manually.`;
}

export async function updateReleaseBody(
  octokit: Octokit,
  target: RepositoryTarget,
  releaseId: number,
  body: string,
): Promise<Release> {
  const response = await retry(() =>
    octokit.rest.repos.updateRelease({
      ...target,
      release_id: releaseId,
      body,
    }),
  );
  return response.data;
}

export async function createRelease(
  octokit: Octokit,
  target: RepositoryTarget,
  tag: string,
  assetName: string,
): Promise<Release> {
  const body = managedReleaseBody(target, tag, assetName);

  try {
    const response = await octokit.rest.repos.createRelease({
      ...target,
      tag_name: tag,
      name: "Terraform state",
      body,
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

export type RepositoryFile = {
  content: Buffer;
};

export async function getRefSha(
  octokit: Octokit,
  target: RepositoryTarget,
  branch: string,
): Promise<string> {
  const response = await retry(() =>
    octokit.rest.git.getRef({ ...target, ref: `heads/${branch}` }),
  );
  return response.data.object.sha;
}

export async function getOptionalRefSha(
  octokit: Octokit,
  target: RepositoryTarget,
  branch: string,
): Promise<string | undefined> {
  try {
    return await getRefSha(octokit, target, branch);
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}

export async function createBranch(
  octokit: Octokit,
  target: RepositoryTarget,
  branch: string,
  sha: string,
): Promise<string> {
  try {
    const response = await retry(() =>
      octokit.rest.git.createRef({
        ...target,
        ref: `refs/heads/${branch}`,
        sha,
      }),
    );
    return response.data.object.sha;
  } catch (error) {
    if ((error as { status?: number }).status !== 422) throw error;
    return getRefSha(octokit, target, branch);
  }
}

type TreeEntry = {
  mode?: string;
  path?: string;
  sha?: string | null;
  type?: string;
};

async function commitTreeSha(
  octokit: Octokit,
  target: RepositoryTarget,
  commitSha: string,
): Promise<string> {
  const response = await retry(() =>
    octokit.rest.git.getCommit({ ...target, commit_sha: commitSha }),
  );
  return response.data.tree.sha;
}

async function recursiveTree(
  octokit: Octokit,
  target: RepositoryTarget,
  treeSha: string,
): Promise<Map<string, string>> {
  const response = await retry(() =>
    octokit.rest.git.getTree({
      ...target,
      tree_sha: treeSha,
      recursive: "true",
    }),
  );
  if (response.data.truncated) {
    fail(
      `Repository tree ${treeSha} is too large to inspect safely; refusing to refresh the import PR branch.`,
    );
  }
  const entries = new Map<string, string>();
  for (const entry of response.data.tree as TreeEntry[]) {
    if (!entry.path || entry.type === "tree") continue;
    entries.set(
      entry.path,
      `${entry.mode || ""}:${entry.type || ""}:${entry.sha || ""}`,
    );
  }
  return entries;
}

export async function inspectBranchDiff(
  octokit: Octokit,
  target: RepositoryTarget,
  base: string,
  branch: string,
): Promise<{ baseIsAncestor: boolean; changedPaths: string[] }> {
  const comparison = await retry(() =>
    octokit.rest.repos.compareCommitsWithBasehead({
      ...target,
      basehead: `${base}...${branch}`,
      per_page: 1,
    }),
  );
  const mergeBaseSha = comparison.data.merge_base_commit.sha;
  if (!mergeBaseSha) {
    fail(
      `Cannot determine the merge base for ${base} and ${branch}; refusing to refresh the import PR branch.`,
    );
  }
  const [mergeBaseTree, branchTree] = await Promise.all([
    commitTreeSha(octokit, target, mergeBaseSha),
    commitTreeSha(octokit, target, branch),
  ]);
  const [before, after] = await Promise.all([
    recursiveTree(octokit, target, mergeBaseTree),
    recursiveTree(octokit, target, branchTree),
  ]);
  return {
    baseIsAncestor: mergeBaseSha === base,
    changedPaths: [...new Set([...before.keys(), ...after.keys()])]
      .filter((path) => before.get(path) !== after.get(path))
      .sort(),
  };
}

export async function rebuildBranchFromBase(
  octokit: Octokit,
  target: RepositoryTarget,
  branch: string,
  expectedBranchSha: string,
  baseSha: string,
  baseIsAncestor: boolean,
  path: string,
  content: Buffer,
  message: string,
): Promise<boolean> {
  const [baseTreeSha, branchTreeSha, blob] = await Promise.all([
    commitTreeSha(octokit, target, baseSha),
    commitTreeSha(octokit, target, expectedBranchSha),
    retry(() =>
      octokit.rest.git.createBlob({
        ...target,
        content: content.toString("base64"),
        encoding: "base64",
      }),
    ),
  ]);
  const tree = await retry(() =>
    octokit.rest.git.createTree({
      ...target,
      base_tree: baseTreeSha,
      tree: [{ path, mode: "100644", type: "blob", sha: blob.data.sha }],
    }),
  );
  if (tree.data.sha === branchTreeSha && baseIsAncestor) return false;

  const parents =
    expectedBranchSha === baseSha
      ? [expectedBranchSha]
      : [expectedBranchSha, baseSha];
  const commit = await retry(() =>
    octokit.rest.git.createCommit({
      ...target,
      message,
      tree: tree.data.sha,
      parents,
    }),
  );
  try {
    const currentSha = await getRefSha(octokit, target, branch);
    if (currentSha !== expectedBranchSha) {
      fail(
        `PR branch ${branch} changed from expected SHA ${expectedBranchSha} to ${currentSha} during refresh; refusing to overwrite it.`,
      );
    }
    await retry(() =>
      octokit.rest.git.updateRef({
        ...target,
        ref: `heads/${branch}`,
        sha: commit.data.sha,
        force: false,
      }),
    );
    return true;
  } catch (error) {
    const currentSha = await getRefSha(octokit, target, branch);
    const currentTreeSha = await commitTreeSha(octokit, target, currentSha);
    if (currentTreeSha === tree.data.sha) {
      const currentComparison = await inspectBranchDiff(
        octokit,
        target,
        baseSha,
        currentSha,
      );
      if (
        currentComparison.baseIsAncestor &&
        currentComparison.changedPaths.every(
          (changedPath) => changedPath === path,
        )
      ) {
        return false;
      }
    }
    if (currentSha !== expectedBranchSha) {
      fail(
        `PR branch ${branch} changed from expected SHA ${expectedBranchSha} to ${currentSha} during refresh; refusing to overwrite it.`,
      );
    }
    throw error;
  }
}

export async function getRepositoryFile(
  octokit: Octokit,
  target: RepositoryTarget,
  path: string,
  branch: string,
): Promise<RepositoryFile | undefined> {
  try {
    const response = await retry(() =>
      octokit.rest.repos.getContent({ ...target, path, ref: branch }),
    );
    const data = response.data;
    if (Array.isArray(data) || data.type !== "file" || !data.content) {
      fail(`Repository path ${path} is not a regular file.`);
    }
    return {
      content: Buffer.from(data.content.replaceAll(/\s/g, ""), "base64"),
    };
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}

export type PullRequest = {
  html_url: string;
  number: number;
};

export async function findOpenPullRequest(
  octokit: Octokit,
  target: RepositoryTarget,
  branch: string,
  base: string,
): Promise<PullRequest | undefined> {
  const response = await retry(() =>
    octokit.rest.pulls.list({
      ...target,
      state: "open",
      head: `${target.owner}:${branch}`,
      base,
      per_page: 10,
    }),
  );
  return response.data[0];
}

export async function createPullRequest(
  octokit: Octokit,
  target: RepositoryTarget,
  branch: string,
  base: string,
  title: string,
  body: string,
): Promise<PullRequest> {
  const response = await retry(() =>
    octokit.rest.pulls.create({
      ...target,
      head: branch,
      base,
      title,
      body,
    }),
  );
  return response.data;
}

export async function updatePullRequest(
  octokit: Octokit,
  target: RepositoryTarget,
  number: number,
  title: string,
  body: string,
): Promise<void> {
  await retry(() =>
    octokit.rest.pulls.update({
      ...target,
      pull_number: number,
      title,
      body,
    }),
  );
}

export async function closePullRequest(
  octokit: Octokit,
  target: RepositoryTarget,
  number: number,
): Promise<void> {
  await retry(() =>
    octokit.rest.pulls.update({
      ...target,
      pull_number: number,
      state: "closed",
    }),
  );
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
  const expectedDigest = assetDigest(asset);
  if (expectedDigest && expectedDigest !== sha256(data)) {
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
