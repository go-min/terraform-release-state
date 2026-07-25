import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  deleteAsset,
  deleteRelease,
  deleteTag,
  downloadAsset,
  getRelease,
  listAssets,
  uploadAsset,
  // @ts-expect-error Node's native TypeScript runner resolves this source path directly.
} from "../src/github-api.mts";

const target = { owner: "ter-sh", repo: "state" };
const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

test("getRelease treats a missing release as absent", async () => {
  const octokit = {
    rest: { repos: { getReleaseByTag: async () => { throw failure(404); } } },
  } as never;
  assert.equal(await getRelease(octokit, target, "terraform-state"), undefined);
});

test("getRelease preserves permission errors", async () => {
  const octokit = {
    rest: { repos: { getReleaseByTag: async () => { throw failure(403); } } },
  } as never;
  await assert.rejects(
    getRelease(octokit, target, "terraform-state"),
    /HTTP 403/,
  );
});

test("listAssets uses pagination through the internal API client", async () => {
  const calls: unknown[] = [];
  const octokit = {
    paginate: async (method: unknown, params: unknown) => {
      calls.push([method, params]);
      return [{ id: 1 }, { id: 2 }];
    },
    rest: { repos: { listReleaseAssets: "list" } },
  } as never;
  const assets = await listAssets(octokit, target, 12);
  assert.equal(assets.length, 2);
  assert.deepEqual(calls, [["list", { ...target, release_id: 12, per_page: 100 }]]);
});

test("deletions retry transient failures", async () => {
  let attempts = 0;
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async () => {
          attempts += 1;
          if (attempts < 2) throw failure(503);
        },
        deleteRelease: async () => undefined,
      },
      git: { deleteRef: async () => undefined },
    },
  } as never;
  await deleteAsset(octokit, target, 1);
  assert.equal(attempts, 2);
});

test("downloadAsset rejects a digest mismatch without exposing content", async () => {
  const octokit = {
    request: async () => ({ data: Buffer.from("unexpected") }),
  } as never;
  const asset = {
    id: 1,
    name: "terraform.tfstate",
    size: 10,
    digest: "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  } as never;
  await assert.rejects(
    downloadAsset(octokit, target, asset),
    /Integrity check failed/,
  );
});

test("uploadAsset uses the release asset API and content length", async () => {
  let request: unknown;
  const octokit = {
    rest: {
      repos: {
        uploadReleaseAsset: async (options: unknown) => {
          request = options;
          return { data: { id: 3, name: "terraform.tfstate" } };
        },
      },
    },
  } as never;
  const data = Buffer.from("state");
  const result = await uploadAsset(octokit, target, 12, "terraform.tfstate", data);
  assert.deepEqual(result, { id: 3, name: "terraform.tfstate" });
  assert.deepEqual(request, {
    ...target,
    release_id: 12,
    name: "terraform.tfstate",
    data: data as unknown as string,
    headers: { "content-type": "application/octet-stream", "content-length": 5 },
  });
});

test("retry stops after the bounded transient retry budget", async () => {
  let attempts = 0;
  const octokit = {
    rest: {
      repos: {
        deleteRelease: async () => {
          attempts += 1;
          throw failure(503);
        },
      },
    },
  } as never;
  await assert.rejects(deleteRelease(octokit, target, 12), /HTTP 503/);
  assert.equal(attempts, 5);
});

test("deletions treat 404 as already absent", async () => {
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async () => { throw failure(404); },
        deleteRelease: async () => { throw failure(404); },
      },
      git: { deleteRef: async () => { throw failure(404); } },
    },
  } as never;
  await deleteAsset(octokit, target, 1);
  await deleteRelease(octokit, target, 2);
  await deleteTag(octokit, target, "terraform-state");
});

test("non-retryable deletion failures remain errors", async () => {
  const octokit = {
    rest: {
      repos: { deleteReleaseAsset: async () => { throw failure(403); } },
    },
  } as never;
  await assert.rejects(deleteAsset(octokit, target, 1), /HTTP 403/);
});
