import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

// @ts-expect-error This source module is compiled into the temporary native-test build.
const { save } = await import("../.test-build/src/state-manager.mjs");

test("save restores the previous current state when upload verification fails", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-save-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const previous = Buffer.from("previous-state");
  const next = Buffer.from("next-state");
  writeFileSync(statePath, next, { mode: 0o600 });

  const release = { id: 1 } as never;
  let nextAssetId = 10;
  const payloads = new Map<number, Buffer>([[1, previous]]);
  type FakeAsset = {
    id: number;
    name: string;
    state: "uploaded";
    size: number;
    digest: string;
    updated_at: string;
    created_at: string;
  };
  let assets: FakeAsset[] = [
    {
      id: 1,
      name: "terraform.tfstate",
      state: "uploaded",
      size: previous.length,
      digest: "",
      updated_at: "2026-07-25T10:00:00Z",
      created_at: "2026-07-25T10:00:00Z",
    },
  ];

  const octokit = {
    paginate: async () => assets,
    request: async (_route: string, options: { asset_id: number }) => ({
      data:
        options.asset_id === 12
          ? Buffer.from("corrupt")
          : payloads.get(options.asset_id),
    }),
    rest: {
      repos: {
        getReleaseByTag: async () => ({ data: release }),
        listReleaseAssets: "list",
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          assets = assets.filter((asset) => asset.id !== asset_id);
        },
        uploadReleaseAsset: async ({
          name,
          data,
        }: {
          name: string;
          data: Buffer;
        }) => {
          const id = nextAssetId;
          nextAssetId += 1;
          const asset: FakeAsset = {
            id,
            name,
            state: "uploaded",
            size: data.length,
            digest: "",
            updated_at: `2026-07-25T10:00:${id}Z`,
            created_at: `2026-07-25T10:00:${id}Z`,
          };
          assets.push(asset);
          payloads.set(id, data);
          return { data: asset };
        },
      },
    },
  } as never;

  const config = {
    operation: "save",
    token: "token",
    target: { owner: "ter-sh", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath,
    bootstrap: false,
    expectedMarker: Buffer.from(
      JSON.stringify({
        id: 1,
        name: "terraform.tfstate",
        digest: "",
        size: previous.length,
        updatedAt: "2026-07-25T10:00:00Z",
      }),
    ).toString("base64url"),
    backupRetention: 20,
    sourceCommit: "",
    workflowRunId: "",
    resetConfirmation: "",
    encryption: { mode: "none", recipients: [], identities: [] },
  } as never;

  try {
    await assert.rejects(
      save({ octokit, config }),
      /failed checksum verification/,
    );
    const current = assets.find((asset) => asset.name === "terraform.tfstate");
    assert.ok(current);
    assert.deepEqual(payloads.get(current.id), previous);
    assert.equal(readFileSync(statePath, "utf8"), "next-state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
