import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript runner resolves this source path directly.
import { isResetAsset, resetWithClient, resetAssets } from "../src/reset-core.mts";

const config = {
  operation: "reset",
  token: "token",
  target: { owner: "ter-sh", repo: "state" },
  tag: "terraform-state",
  assetName: "terraform.tfstate",
  statePath: "/workspace/unused",
  bootstrap: false,
  expectedMarker: "",
  backupRetention: 20,
  sourceCommit: "",
  workflowRunId: "",
  resetConfirmation: "RESET",
} as never;

const asset = (id: number, name: string) => ({
  id,
  name,
  state: "uploaded",
}) as never;

const release = { id: 7 } as never;

test("reset only recognizes current state and backup namespace", () => {
  assert.equal(isResetAsset("terraform.tfstate", "terraform.tfstate"), true);
  assert.equal(
    isResetAsset("terraform.tfstate.backup-20260725T120000Z", "terraform.tfstate"),
    true,
  );
  assert.equal(isResetAsset("terraform.tfstate.other", "terraform.tfstate"), false);
  assert.deepEqual(
    resetAssets(
      [
        asset(1, "terraform.tfstate"),
        asset(2, "terraform.tfstate.backup-a"),
        asset(3, "unrelated.zip"),
      ],
      "terraform.tfstate",
    ),
    {
      owned: [asset(1, "terraform.tfstate"), asset(2, "terraform.tfstate.backup-a")],
      unexpected: [asset(3, "unrelated.zip")],
    },
  );
});

test("reset deletes assets, release, and tag through the client", async () => {
  const calls: string[] = [];
  const result = await resetWithClient(
    { config } as never,
    {
      getRelease: async () => release,
      listAssets: async () => [asset(1, "terraform.tfstate"), asset(2, "terraform.tfstate.backup-a")],
      deleteAsset: async (_target, id) => { calls.push(`asset:${id}`); },
      deleteRelease: async (_target, id) => { calls.push(`release:${id}`); },
      deleteTag: async (_target, tag) => { calls.push(`tag:${tag}`); },
    },
  );
  assert.deepEqual(result, { deletedAssetCount: 2, releaseFound: true });
  assert.deepEqual(calls, ["asset:1", "asset:2", "release:7", "tag:terraform-state"]);
});

test("reset fails closed before deleting when release has unrelated assets", async () => {
  const calls: string[] = [];
  await assert.rejects(
    resetWithClient(
      { config } as never,
      {
        getRelease: async () => release,
        listAssets: async () => [asset(1, "terraform.tfstate"), asset(9, "unrelated.zip")],
        deleteAsset: async () => { calls.push("asset"); },
        deleteRelease: async () => { calls.push("release"); },
        deleteTag: async () => { calls.push("tag"); },
      },
    ),
    /non-state assets/,
  );
  assert.deepEqual(calls, []);
});

test("reset is idempotent when the release is already absent", async () => {
  const calls: string[] = [];
  const result = await resetWithClient(
    { config } as never,
    {
      getRelease: async () => undefined,
      listAssets: async () => [],
      deleteAsset: async () => { calls.push("asset"); },
      deleteRelease: async () => { calls.push("release"); },
      deleteTag: async () => { calls.push("tag"); },
    },
  );
  assert.deepEqual(result, { deletedAssetCount: 0, releaseFound: false });
  assert.deepEqual(calls, ["tag"]);
});

test("partial deletion stops and can be retried safely", async () => {
  const calls: string[] = [];
  await assert.rejects(
    resetWithClient(
      { config } as never,
      {
        getRelease: async () => release,
        listAssets: async () => [asset(1, "terraform.tfstate"), asset(2, "terraform.tfstate.backup-a")],
        deleteAsset: async (_target, id) => {
          calls.push(`asset:${id}`);
          if (id === 2) throw new Error("temporary delete failure");
        },
        deleteRelease: async () => { calls.push("release"); },
        deleteTag: async () => { calls.push("tag"); },
      },
    ),
    /temporary delete failure/,
  );
  assert.deepEqual(calls, ["asset:1", "asset:2"]);
});
