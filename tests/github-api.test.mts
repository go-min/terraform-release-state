import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript runner resolves this source path directly.
import { deleteAsset, deleteRelease, deleteTag, listAssets } from "../src/github-api.mts";

const target = { owner: "ter-sh", repo: "state" };
const failure = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

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
