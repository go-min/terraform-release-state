import { strict as assert } from "node:assert";
import { test } from "node:test";

const { createBackup, retainBackups } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/backup-manager.mjs"
);

const failure = (status: number) =>
  Object.assign(new Error(`HTTP ${status}`), { status });

const baseConfig = {
  operation: "save",
  token: "token",
  target: { owner: "go-min", repo: "state" },
  tag: "terraform-state",
  assetName: "terraform.tfstate",
  workspace: "/workspace",
  statePath: "/workspace/terraform.tfstate",
  bootstrap: false,
  expectedMarker: "",
  backupRetention: 1,
  sourceCommit: "source-sha",
  workflowRunId: "run-id",
  resetConfirmation: "",
  encryption: { mode: "none", recipients: [], identities: [] },
} as const;

const release = { id: 7 } as never;

function asset(id: number, name: string, createdAt: string) {
  return {
    id,
    name,
    state: "uploaded",
    created_at: createdAt,
  };
}

test("backup upload creates paired recovery metadata", async () => {
  const uploads: Array<{ name: string; data: Buffer }> = [];
  const payloads = new Map<number, Buffer>();
  let nextId = 1;
  const octokit = {
    request: async (_route: string, options: { asset_id: number }) => ({
      data: payloads.get(options.asset_id),
    }),
    rest: {
      repos: {
        uploadReleaseAsset: async ({
          name,
          data,
        }: {
          name: string;
          data: Buffer;
        }) => {
          uploads.push({ name, data });
          payloads.set(nextId, data);
          return {
            data: asset(nextId++, name, "2026-07-26T10:00:00Z"),
          };
        },
      },
    },
  } as never;

  const name = await createBackup(
    { octokit, config: baseConfig } as never,
    release,
    { name: "terraform.tfstate" } as never,
    Buffer.from("previous-state"),
  );

  assert.equal(uploads[0].name, name);
  assert.equal(uploads[1].name, `${name}.metadata.json`);
  const metadata = JSON.parse(uploads[1].data.toString("utf8"));
  assert.equal(metadata.source_commit, "source-sha");
  assert.equal(metadata.workflow_run_id, "run-id");
  assert.equal(metadata.current_asset, "terraform.tfstate");
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
});

test("corrupt backup state download removes the uploaded pair", async () => {
  const deleted: number[] = [];
  const payloads = new Map<number, Buffer>();
  let assets: ReturnType<typeof asset>[] = [];
  let nextId = 1;
  const octokit = {
    paginate: async () => assets,
    request: async (_route: string, options: { asset_id: number }) => ({
      data:
        options.asset_id === 1
          ? Buffer.from("corrupt-state")
          : payloads.get(options.asset_id),
    }),
    rest: {
      repos: {
        listReleaseAssets: "list",
        uploadReleaseAsset: async ({
          name,
          data,
        }: {
          name: string;
          data: Buffer;
        }) => {
          const uploaded = asset(nextId++, name, "2026-07-26T10:00:00Z");
          assets.push(uploaded);
          payloads.set(uploaded.id, data);
          return { data: uploaded };
        },
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
          assets = assets.filter((item) => item.id !== asset_id);
        },
      },
    },
  } as never;

  await assert.rejects(
    createBackup(
      { octokit, config: baseConfig } as never,
      release,
      { name: "terraform.tfstate" } as never,
      Buffer.from("previous-state"),
    ),
    /Backup state asset .* failed checksum verification/,
  );
  assert.deepEqual(deleted, [2, 1]);
  assert.deepEqual(assets, []);
});

test("corrupt backup metadata download removes the uploaded pair", async () => {
  const deleted: number[] = [];
  const payloads = new Map<number, Buffer>();
  let assets: ReturnType<typeof asset>[] = [];
  let nextId = 1;
  const octokit = {
    paginate: async () => assets,
    request: async (_route: string, options: { asset_id: number }) => ({
      data:
        options.asset_id === 2
          ? Buffer.from("corrupt-metadata")
          : payloads.get(options.asset_id),
    }),
    rest: {
      repos: {
        listReleaseAssets: "list",
        uploadReleaseAsset: async ({
          name,
          data,
        }: {
          name: string;
          data: Buffer;
        }) => {
          const uploaded = asset(nextId++, name, "2026-07-26T10:00:00Z");
          assets.push(uploaded);
          payloads.set(uploaded.id, data);
          return { data: uploaded };
        },
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
          assets = assets.filter((item) => item.id !== asset_id);
        },
      },
    },
  } as never;

  await assert.rejects(
    createBackup(
      { octokit, config: baseConfig } as never,
      release,
      { name: "terraform.tfstate" } as never,
      Buffer.from("previous-state"),
    ),
    /Backup metadata asset .* failed checksum verification/,
  );
  assert.deepEqual(deleted, [2, 1]);
  assert.deepEqual(assets, []);
});

test("metadata upload failure removes the partial backup", async () => {
  let assets = [asset(1, "terraform.tfstate.backup-partial", "2026-07-26")];
  const deleted: number[] = [];
  let uploadCount = 0;
  const octokit = {
    paginate: async () => assets,
    rest: {
      repos: {
        listReleaseAssets: "list",
        uploadReleaseAsset: async ({ name }: { name: string }) => {
          uploadCount += 1;
          if (uploadCount === 2) throw failure(403);
          assets = [asset(1, name, "2026-07-26")];
          return { data: assets[0] };
        },
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
          assets = assets.filter((item) => item.id !== asset_id);
        },
      },
    },
  } as never;

  await assert.rejects(
    createBackup(
      { octokit, config: baseConfig } as never,
      release,
      { name: "terraform.tfstate" } as never,
      Buffer.from("previous-state"),
    ),
    /HTTP 403/,
  );
  assert.deepEqual(deleted, [1]);
  assert.deepEqual(assets, []);
});

test("backup cleanup failure preserves the metadata upload error as cause", async (context) => {
  context.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    callback();
    return {} as NodeJS.Timeout;
  });
  let assets = [asset(1, "terraform.tfstate.backup-partial", "2026-07-26")];
  let uploadCount = 0;
  let deleteAttempts = 0;
  const octokit = {
    paginate: async () => assets,
    rest: {
      repos: {
        listReleaseAssets: "list",
        uploadReleaseAsset: async ({ name }: { name: string }) => {
          uploadCount += 1;
          if (uploadCount === 2) throw failure(403);
          assets = [asset(1, name, "2026-07-26")];
          return { data: assets[0] };
        },
        deleteReleaseAsset: async () => {
          deleteAttempts += 1;
          throw failure(503);
        },
      },
    },
  } as never;

  let caught: unknown;
  try {
    await createBackup(
      { octokit, config: baseConfig } as never,
      release,
      { name: "terraform.tfstate" } as never,
      Buffer.from("previous-state"),
    );
  } catch (error) {
    caught = error;
  }

  assert.ok(caught instanceof Error);
  assert.match(
    caught.message,
    /Backup pair creation failed and compensating cleanup could not complete/,
  );
  assert.match(String(caught.cause), /HTTP 403/);
  assert.equal(deleteAttempts, 5);
});

test("retention removes orphans and deletes metadata before backups", async () => {
  const deleted: number[] = [];
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
        },
      },
    },
  } as never;
  const assets = [
    asset(1, "terraform.tfstate.backup-new", "2026-07-26T10:00:00Z"),
    asset(
      2,
      "terraform.tfstate.backup-new.metadata.json",
      "2026-07-26T10:00:00Z",
    ),
    asset(3, "terraform.tfstate.backup-old", "2026-07-26T09:00:00Z"),
    asset(
      4,
      "terraform.tfstate.backup-old.metadata.json",
      "2026-07-26T09:00:00Z",
    ),
    asset(5, "terraform.tfstate.backup-orphan", "2026-07-26T08:00:00Z"),
    asset(
      6,
      "terraform.tfstate.backup-missing.metadata.json",
      "2026-07-26T08:00:00Z",
    ),
  ];

  assert.equal(
    await retainBackups({ octokit, config: baseConfig } as never, assets),
    1,
  );
  assert.deepEqual(deleted, [6, 5, 4, 3]);
});

test("retention uses asset IDs to break equal timestamp ties", async () => {
  const deleted: number[] = [];
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
        },
      },
    },
  } as never;
  const timestamp = "2026-07-26T10:00:00Z";
  const assets = [
    asset(10, "terraform.tfstate.backup-new", timestamp),
    asset(11, "terraform.tfstate.backup-new.metadata.json", timestamp),
    asset(5, "terraform.tfstate.backup-old", timestamp),
    asset(6, "terraform.tfstate.backup-old.metadata.json", timestamp),
  ];

  assert.equal(
    await retainBackups({ octokit, config: baseConfig } as never, assets),
    1,
  );
  assert.deepEqual(deleted, [6, 5]);
});

test("retention stops before deleting a backup when metadata deletion fails", async (context) => {
  context.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    callback();
    return {} as NodeJS.Timeout;
  });
  const deleted: number[] = [];
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
          throw failure(503);
        },
      },
    },
  } as never;
  const config = { ...baseConfig, backupRetention: 0 };
  const assets = [
    asset(1, "terraform.tfstate.backup-only", "2026-07-26T10:00:00Z"),
    asset(
      2,
      "terraform.tfstate.backup-only.metadata.json",
      "2026-07-26T10:00:00Z",
    ),
  ];

  await assert.rejects(
    retainBackups({ octokit, config } as never, assets),
    /HTTP 503/,
  );
  assert.deepEqual(deleted, [2, 2, 2, 2, 2]);
});
