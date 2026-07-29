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
  receiptPath: "/runner/receipt.json",
  backupRetention: 1,
  sourceCommit: "source-sha",
  workflowRunId: "run-id",
  resetTarget: "all",
} as const;

const release = { id: 7 } as never;

function asset(id: number, name: string, createdAt: string, data?: Buffer) {
  return {
    id,
    name,
    state: "uploaded",
    created_at: createdAt,
    updated_at: createdAt,
    size: data?.length || 0,
    digest: "",
  };
}

function legacyPrevious(data: Buffer) {
  const current = asset(99, "terraform.tfstate", "2026-07-26T09:00:00Z", data);
  return {
    objectName: "terraform.tfstate",
    role: "current",
    assets: { state: current },
    stored: data,
    plaintext: data,
    format: "legacy",
    signature: { status: "unsigned", keyFingerprint: "" },
    storedVerification: "not-recorded",
    plaintextVerification: "not-recorded",
    warnings: ["TRS_LEGACY_UNSIGNED"],
  };
}

function backupApi(
  options: {
    corruptId?: number;
    failUploadAt?: number;
    failDelete?: boolean;
  } = {},
) {
  const uploads: Array<{ name: string; data: Buffer }> = [];
  const payloads = new Map<number, Buffer>();
  let assets: ReturnType<typeof asset>[] = [];
  let nextId = 1;
  const deleted: number[] = [];
  const octokit = {
    paginate: async () => assets,
    request: async (_route: string, request: { asset_id: number }) => ({
      data:
        request.asset_id === options.corruptId
          ? Buffer.from(`corrupt-${request.asset_id}`)
          : payloads.get(request.asset_id),
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
          if (nextId === options.failUploadAt) throw failure(403);
          const uploaded = asset(nextId++, name, "2026-07-26T10:00:00Z", data);
          uploads.push({ name, data });
          assets.push(uploaded);
          payloads.set(uploaded.id, data);
          return { data: uploaded };
        },
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
          if (options.failDelete) throw failure(503);
          assets = assets.filter((item) => item.id !== asset_id);
        },
      },
    },
  } as never;
  return { octokit, uploads, payloads, deleted, assets: () => assets };
}

test("backup upload creates and verifies a manifest-complete flat bundle", async () => {
  const api = backupApi();
  const previous = Buffer.from("previous-state");
  const name = await createBackup(
    { octokit: api.octokit, config: baseConfig } as never,
    release,
    legacyPrevious(previous).assets.state as never,
    legacyPrevious(previous) as never,
  );

  assert.deepEqual(
    api.uploads.map((upload) => upload.name),
    [name, `${name}.metadata.json`, `${name}.manifest.json`],
  );
  const metadata = JSON.parse(api.uploads[1].data.toString("utf8"));
  assert.equal(metadata.source_commit, "source-sha");
  assert.equal(metadata.workflow_run_id, "run-id");
  assert.equal(metadata.current_asset, "terraform.tfstate");
  assert.match(metadata.sha256, /^[a-f0-9]{64}$/);
  const manifest = JSON.parse(api.uploads[2].data.toString("utf8"));
  assert.equal(manifest.object.role, "backup");
  assert.equal(manifest.object.name, name);
  assert.equal(manifest.content.stored.sha256, metadata.sha256);
});

for (const [kind, corruptId] of [
  ["state", 1],
  ["metadata", 2],
  ["manifest", 3],
] as const) {
  test(`corrupt backup ${kind} download removes the uploaded bundle`, async () => {
    const api = backupApi({ corruptId });
    const previous = Buffer.from("previous-state");
    await assert.rejects(
      createBackup(
        { octokit: api.octokit, config: baseConfig } as never,
        release,
        legacyPrevious(previous).assets.state as never,
        legacyPrevious(previous) as never,
      ),
      /failed checksum verification|valid UTF-8 JSON|checksum does not match/i,
    );
    assert.deepEqual(api.deleted, [3, 2, 1]);
    assert.deepEqual(api.assets(), []);
  });
}

test("metadata upload failure removes the partial backup", async () => {
  const api = backupApi({ failUploadAt: 2 });
  const previous = Buffer.from("previous-state");
  await assert.rejects(
    createBackup(
      { octokit: api.octokit, config: baseConfig } as never,
      release,
      legacyPrevious(previous).assets.state as never,
      legacyPrevious(previous) as never,
    ),
    /HTTP 403/,
  );
  assert.deepEqual(api.deleted, [1]);
  assert.deepEqual(api.assets(), []);
});

test("backup cleanup failure preserves the upload error as cause", async (context) => {
  context.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    callback();
    return {} as NodeJS.Timeout;
  });
  const api = backupApi({ failUploadAt: 2, failDelete: true });
  const previous = Buffer.from("previous-state");
  let caught: unknown;
  try {
    await createBackup(
      { octokit: api.octokit, config: baseConfig } as never,
      release,
      legacyPrevious(previous).assets.state as never,
      legacyPrevious(previous) as never,
    );
  } catch (error) {
    caught = error;
  }
  assert.ok(caught instanceof Error);
  assert.match(caught.message, /Backup bundle creation failed/);
  assert.match(String(caught.cause), /HTTP 403/);
  assert.equal(api.deleted.length, 5);
});

test("retention removes orphans and deletes companions before backups", async () => {
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
    await retainBackups(
      { octokit, config: baseConfig } as never,
      assets as never,
    ),
    1,
  );
  assert.deepEqual(deleted, [6, 5, 4, 3]);
});

test("retention groups manifest and signature companions with their backup", async () => {
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
  const config = { ...baseConfig, backupRetention: 0 };
  const assets = [
    asset(1, "terraform.tfstate.backup-a", "2026-07-26T10:00:00Z"),
    asset(
      2,
      "terraform.tfstate.backup-a.metadata.json",
      "2026-07-26T10:00:00Z",
    ),
    asset(
      3,
      "terraform.tfstate.backup-a.manifest.json",
      "2026-07-26T10:00:00Z",
    ),
    asset(
      4,
      "terraform.tfstate.backup-a.manifest.sig.json",
      "2026-07-26T10:00:00Z",
    ),
  ];
  assert.equal(
    await retainBackups({ octokit, config } as never, assets as never),
    0,
  );
  assert.deepEqual(deleted, [4, 3, 2, 1]);
});

test("signed retention stops at signature deletion failure", async (context) => {
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
          if (asset_id === 4) throw failure(503);
        },
      },
    },
  } as never;
  const config = { ...baseConfig, backupRetention: 0 };
  const assets = [
    asset(1, "terraform.tfstate.backup-signed", "2026-07-26T10:00:00Z"),
    asset(
      2,
      "terraform.tfstate.backup-signed.metadata.json",
      "2026-07-26T10:00:00Z",
    ),
    asset(
      3,
      "terraform.tfstate.backup-signed.manifest.json",
      "2026-07-26T10:00:00Z",
    ),
    asset(
      4,
      "terraform.tfstate.backup-signed.manifest.sig.json",
      "2026-07-26T10:00:00Z",
    ),
  ];
  await assert.rejects(
    retainBackups({ octokit, config } as never, assets as never),
    /HTTP 503/,
  );
  assert.deepEqual(deleted, [4, 4, 4, 4, 4]);
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
    await retainBackups(
      { octokit, config: baseConfig } as never,
      assets as never,
    ),
    1,
  );
  assert.deepEqual(deleted, [6, 5]);
});

test("retention stops before deleting state when companion deletion fails", async (context) => {
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
    retainBackups({ octokit, config } as never, assets as never),
    /HTTP 503/,
  );
  assert.deepEqual(deleted, [2, 2, 2, 2, 2]);
});
