import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { reset } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/reset.mjs"
);
const { createBundleData } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-bundle.mjs"
);
const { createBackupMetadata } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-metadata.mjs"
);

type FakeAsset = {
  id: number;
  name: string;
  state: "uploaded";
  size: number;
  digest: string;
  created_at: string;
  updated_at: string;
};

function asset(id: number, name: string, data: Buffer): FakeAsset {
  return {
    id,
    name,
    state: "uploaded",
    size: data.length,
    digest: "",
    created_at: `2026-07-29T10:00:${id.toString().padStart(2, "0")}Z`,
    updated_at: `2026-07-29T10:00:${id.toString().padStart(2, "0")}Z`,
  };
}

function manifestBundle(
  role: "current" | "backup",
  name: string,
  data: Buffer,
) {
  const metadata =
    role === "backup"
      ? createBackupMetadata({
          stored: data,
          currentAsset: "terraform.tfstate",
          encryption: "none",
          sourceCommit: "source",
          workflowRunId: "run",
          actionVersion: "v0.4.0",
          createdAt: "2026-07-29T10:00:00.000Z",
        })
      : undefined;
  return createBundleData(
    {
      role,
      name,
      stored: data,
      plaintext: data,
      encryptionMode: "none",
      encryptionKeyFingerprint: null,
      parentMarker: null,
      parentStoredSha256: null,
      sourceCommit: "source",
      workflowRunId: "run",
      actionVersion: "v0.4.0",
      createdAt: "2026-07-29T10:00:00.000Z",
    },
    metadata,
  );
}

function promotionApi(options: {
  current?: Buffer;
  failUploadAt?: number;
  corruptTarget?: boolean;
  signedTarget?: boolean;
  moveTargetBeforeCas?: boolean;
}) {
  const backupName = "terraform.tfstate.backup-20260729T100000000Z-run-target";
  const target = Buffer.from("selected-backup-state");
  const targetBundle = manifestBundle("backup", backupName, target);
  const payloads = new Map<number, Buffer>();
  let assets: FakeAsset[] = [];
  let nextId = 10;
  let nextInitialId = 1;
  const addInitial = (name: string, data: Buffer) => {
    const current = asset(nextInitialId++, name, data);
    assets.push(current);
    payloads.set(current.id, data);
  };
  let previousBundle: ReturnType<typeof manifestBundle> | undefined;
  if (options.current) {
    previousBundle = manifestBundle(
      "current",
      "terraform.tfstate",
      options.current,
    );
    addInitial("terraform.tfstate", options.current);
    addInitial("terraform.tfstate.manifest.json", previousBundle.manifest);
  }
  addInitial(backupName, targetBundle.state);
  addInitial(`${backupName}.metadata.json`, targetBundle.metadata as Buffer);
  addInitial(`${backupName}.manifest.json`, targetBundle.manifest);
  if (options.signedTarget) {
    addInitial(`${backupName}.manifest.sig.json`, Buffer.from("signature"));
  }
  const targetIds = assets
    .filter((item) => item.name.startsWith(backupName))
    .map((item) => item.id);
  const deleted: number[] = [];
  const uploadedNames: string[] = [];
  let writes = 0;
  let listCount = 0;
  let uploadFailed = false;
  const octokit = {
    paginate: async () => {
      listCount += 1;
      if (options.moveTargetBeforeCas && listCount === 3) {
        assets = assets.map((item) =>
          item.name === backupName
            ? { ...item, updated_at: "2026-07-29T11:00:00Z" }
            : item,
        );
      }
      return assets;
    },
    request: async (_route: string, request: { asset_id: number }) => ({
      data:
        options.corruptTarget && request.asset_id === targetIds[0]
          ? Buffer.from("corrupt-target")
          : payloads.get(request.asset_id),
    }),
    rest: {
      repos: {
        getReleaseByTag: async () => ({ data: { id: 7, body: "custom" } }),
        listReleaseAssets: "list",
        uploadReleaseAsset: async ({
          name,
          data,
        }: {
          name: string;
          data: Buffer;
        }) => {
          writes += 1;
          if (nextId === options.failUploadAt && !uploadFailed) {
            uploadFailed = true;
            throw new Error("injected promotion upload failure");
          }
          const uploaded = asset(nextId++, name, data);
          uploadedNames.push(name);
          assets.push(uploaded);
          payloads.set(uploaded.id, data);
          return { data: uploaded };
        },
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          writes += 1;
          deleted.push(asset_id);
          assets = assets.filter((item) => item.id !== asset_id);
        },
      },
    },
  } as never;
  return {
    octokit,
    assets: () => assets,
    payloads,
    deleted,
    uploadedNames,
    writes: () => writes,
    backupName,
    target,
    targetIds,
    previousBundle,
  };
}

function config(workspace: string, target: string) {
  return {
    operation: "reset",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath: join(workspace, "terraform.tfstate"),
    receiptPath: join(workspace, "runner", "receipt.json"),
    bootstrap: false,
    backupRetention: 20,
    sourceCommit: "promotion-source",
    workflowRunId: "promotion-run",
    resetTarget: target,
  } as never;
}

test("reset promotes an exact verified backup and uploads manifest last", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-promote-"));
  const output = join(workspace, "outputs.txt");
  const previousOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = output;
  writeFileSync(output, "");
  const previous = Buffer.from("previous-current-state");
  const api = promotionApi({ current: previous });
  try {
    const result = await reset({
      octokit: api.octokit,
      config: config(workspace, api.backupName),
    });
    assert.equal(result.action, "promoted");
    assert.equal(result.target, api.backupName);
    const current = api
      .assets()
      .find((item) => item.name === "terraform.tfstate");
    assert.ok(current);
    assert.deepEqual(api.payloads.get(current.id), api.target);
    assert.deepEqual(
      api
        .assets()
        .filter((item) => api.targetIds.includes(item.id))
        .map((item) => item.id),
      api.targetIds,
      "selected backup must remain unchanged",
    );
    assert.deepEqual(api.uploadedNames.slice(-2), [
      "terraform.tfstate",
      "terraform.tfstate.manifest.json",
    ]);
    assert.match(
      readFileSync(output, "utf8"),
      /state-write-committed<<[^\n]+\ntrue\n/,
    );
    assert.match(
      readFileSync(output, "utf8"),
      /state-status<<[^\n]+\nsuccess\n/,
    );
  } finally {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("partial promotion restores the full previous current bundle", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-promote-rollback-"));
  const previous = Buffer.from("previous-current-state");
  const api = promotionApi({ current: previous, failUploadAt: 14 });
  try {
    await assert.rejects(
      reset({
        octokit: api.octokit,
        config: config(workspace, api.backupName),
      }),
      /injected promotion upload failure/,
    );
    const current = new Map(
      api
        .assets()
        .filter((item) =>
          ["terraform.tfstate", "terraform.tfstate.manifest.json"].includes(
            item.name,
          ),
        )
        .map((item) => [item.name, api.payloads.get(item.id)]),
    );
    assert.deepEqual(current.get("terraform.tfstate"), previous);
    assert.deepEqual(
      current.get("terraform.tfstate.manifest.json"),
      api.previousBundle?.manifest,
    );
    assert.equal(current.size, 2);
    assert.equal(
      api
        .assets()
        .some(
          (item) =>
            item.name === "terraform.tfstate.metadata.json" ||
            item.name === "terraform.tfstate.manifest.sig.json",
        ),
      false,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("promotion from an absent current creates only verified state and manifest", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-promote-absent-"));
  const api = promotionApi({});
  try {
    const result = await reset({
      octokit: api.octokit,
      config: config(workspace, api.backupName),
    });
    assert.equal(result.action, "promoted");
    assert.equal(result.backupAssetName, undefined);
    assert.deepEqual(
      api
        .assets()
        .filter(
          (item) =>
            item.name === "terraform.tfstate" ||
            item.name === "terraform.tfstate.manifest.json",
        )
        .map((item) => item.name),
      ["terraform.tfstate", "terraform.tfstate.manifest.json"],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("promotion rejects companion and traversal reset targets before mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-promote-name-"));
  const api = promotionApi({ current: Buffer.from("current") });
  for (const target of [
    `${api.backupName}.manifest.json`,
    "../terraform.tfstate.backup-invalid",
    "terraform.tfstate.backup-../../invalid",
    "terraform.tfstate",
  ]) {
    await assert.rejects(
      reset({ octokit: api.octokit, config: config(workspace, target) }),
      /reset-target must be all or an exact/,
    );
  }
  assert.equal(api.writes(), 0);
  rmSync(workspace, { recursive: true, force: true });
});

test("corrupt selected backup fails before any mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-promote-corrupt-"));
  const api = promotionApi({
    current: Buffer.from("current"),
    corruptTarget: true,
  });
  try {
    await assert.rejects(
      reset({
        octokit: api.octokit,
        config: config(workspace, api.backupName),
      }),
      /does not match manifest digest/,
    );
    assert.equal(api.writes(), 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("invalid signed selected backup fails before mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-promote-signed-"));
  const api = promotionApi({
    current: Buffer.from("current"),
    signedTarget: true,
  });
  try {
    await assert.rejects(
      reset({
        octokit: api.octokit,
        config: config(workspace, api.backupName),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TRS_SIGNATURE_INVALID",
    );
    assert.equal(api.writes(), 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("target marker race stops after safety backup but before current replacement", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-promote-race-"));
  const previous = Buffer.from("current");
  const api = promotionApi({ current: previous, moveTargetBeforeCas: true });
  try {
    await assert.rejects(
      reset({
        octokit: api.octokit,
        config: config(workspace, api.backupName),
      }),
      /changed during reset preparation/,
    );
    const current = api
      .assets()
      .find((item) => item.name === "terraform.tfstate");
    assert.ok(current);
    assert.deepEqual(api.payloads.get(current.id), previous);
    assert.equal(api.deleted.length, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
