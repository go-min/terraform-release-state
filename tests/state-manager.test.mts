import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import type { ActionConfig } from "../src/types.mts";

const { readStoredState, restore, save } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-manager.mjs"
);
const { createBundleData } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-bundle.mjs"
);
const { marker } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/marker.mjs"
);
const { writeRestoreReceipt } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/receipt.mjs"
);

function digest(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function outputValue(contents: string, name: string): string | undefined {
  const matches = [
    ...contents.matchAll(
      new RegExp(
        `(?:^|\\n)${name}<<([^\\n]+)\\n([\\s\\S]*?)\\n\\1(?:\\n|$)`,
        "g",
      ),
    ),
  ];
  return matches.at(-1)?.[2];
}

function withOutputFile<T>(
  outputPath: string,
  operation: () => Promise<T>,
): Promise<T> {
  const previousOutput = process.env.GITHUB_OUTPUT;
  process.env.GITHUB_OUTPUT = outputPath;
  return operation().finally(() => {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
  });
}

function configFor(workspace: string, overrides: Record<string, unknown> = {}) {
  return {
    operation: "restore",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath: join(workspace, "terraform.tfstate"),
    receiptPath: join(workspace, "runner", "restore-receipt.json"),
    bootstrap: false,
    backupRetention: 20,
    sourceCommit: "source-sha",
    workflowRunId: "run-id",
    resetTarget: "all",
    importsPath: join(workspace, "terraform", "imports.generated.tf"),
    terraformRoot: join(workspace, "terraform"),
    prBase: "main",
    prBranch: "terraform-release-state/imports.generated.tf",
    prTitle: "chore(terraform): update generated imports",
    ...overrides,
  } as ActionConfig;
}

type FakeAsset = {
  id: number;
  name: string;
  state: "uploaded";
  size: number;
  digest: string;
  updated_at: string;
  created_at: string;
};

function fakeAsset(id: number, name: string, data: Buffer): FakeAsset {
  return {
    id,
    name,
    state: "uploaded",
    size: data.length,
    digest: "",
    updated_at: `2026-07-25T10:00:${id.toString().padStart(2, "0")}Z`,
    created_at: `2026-07-25T10:00:${id.toString().padStart(2, "0")}Z`,
  };
}

function stateApi(
  previous?: Buffer,
  options: {
    companions?: Array<{ name: string; data: Buffer }>;
    corruptAssetId?: number;
    failUploadAt?: number;
    failDeleteId?: number;
  } = {},
) {
  let release = { id: 1, body: "operator-owned release notes" };
  let nextAssetId = 10;
  const payloads = new Map<number, Buffer>();
  let assets: FakeAsset[] = [];
  if (previous) {
    assets.push(fakeAsset(1, "terraform.tfstate", previous));
    payloads.set(1, previous);
  }
  for (const companion of options.companions || []) {
    const id = assets.length + 1;
    assets.push(fakeAsset(id, companion.name, companion.data));
    payloads.set(id, companion.data);
  }
  let uploadFailed = false;
  let writeCalls = 0;
  const deleted: number[] = [];
  const octokit = {
    paginate: async () => assets,
    request: async (_route: string, request: { asset_id: number }) => ({
      data:
        request.asset_id === options.corruptAssetId
          ? Buffer.from(`corrupt-${request.asset_id}`)
          : payloads.get(request.asset_id),
    }),
    rest: {
      repos: {
        getReleaseByTag: async () => ({ data: release }),
        listReleaseAssets: "list",
        updateRelease: async ({ body }: { body: string }) => {
          writeCalls += 1;
          release = { ...release, body };
          return { data: release };
        },
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          writeCalls += 1;
          deleted.push(asset_id);
          if (asset_id === options.failDeleteId) {
            throw Object.assign(new Error("injected delete failure"), {
              status: 403,
            });
          }
          assets = assets.filter((asset) => asset.id !== asset_id);
        },
        uploadReleaseAsset: async ({
          name,
          data,
        }: {
          name: string;
          data: Buffer;
        }) => {
          writeCalls += 1;
          if (nextAssetId === options.failUploadAt && !uploadFailed) {
            uploadFailed = true;
            throw new Error("injected upload failure");
          }
          const id = nextAssetId++;
          const uploaded = fakeAsset(id, name, data);
          assets.push(uploaded);
          payloads.set(id, data);
          return { data: uploaded };
        },
      },
    },
  } as never;
  return {
    octokit,
    payloads,
    deleted,
    assets: () => assets,
    release: () => release,
    writeCalls: () => writeCalls,
  };
}

function authorizeSave(
  config: ReturnType<typeof configFor>,
  current?: FakeAsset,
): void {
  writeRestoreReceipt(config, marker(current as never));
}

test("restore and import reads leave custom Release metadata unchanged", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-read-only-"));
  const state = Buffer.from('{"version":4,"resources":[]}');
  const api = stateApi(state);
  const config = configFor(workspace);
  try {
    await restore({ octokit: api.octokit, config });
    assert.deepEqual(
      await readStoredState({ octokit: api.octokit, config }),
      state,
    );
    assert.equal(readFileSync(config.statePath, "utf8"), state.toString());
    assert.equal(api.release().body, "operator-owned release notes");
    assert.equal(api.writeCalls(), 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("restore fails closed on absent storage without bootstrap", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-absent-"));
  let creates = 0;
  const octokit = {
    rest: {
      repos: {
        getReleaseByTag: async () => {
          throw Object.assign(new Error("missing"), { status: 404 });
        },
        createRelease: async () => {
          creates += 1;
          return { data: { id: 1 } };
        },
      },
    },
  } as never;
  try {
    await assert.rejects(
      restore({ octokit, config: configFor(workspace) }),
      /TERRAFORM_BOOTSTRAP=true/,
    );
    assert.equal(creates, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("restore refuses an empty existing Release without bootstrap", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-empty-release-"));
  const api = stateApi();
  try {
    await assert.rejects(
      restore({ octokit: api.octokit, config: configFor(workspace) }),
      /State asset terraform\.tfstate is missing/,
    );
    assert.equal(api.writeCalls(), 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("protected bootstrap creates storage and an absent restore receipt", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-bootstrap-"));
  const config = configFor(workspace, { bootstrap: true });
  let release: { id: number; body: string } | undefined;
  const octokit = {
    paginate: async () => [],
    rest: {
      repos: {
        getReleaseByTag: async () => {
          if (!release)
            throw Object.assign(new Error("missing"), { status: 404 });
          return { data: release };
        },
        createRelease: async ({ body }: { body: string }) => {
          release = { id: 1, body };
          return { data: release };
        },
        listReleaseAssets: "list",
      },
    },
  } as never;
  try {
    await restore({ octokit, config });
    assert.ok(release);
    assert.match(readFileSync(config.receiptPath, "utf8"), /"marker":"absent"/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("save requires a restore receipt before any remote mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-no-receipt-"));
  writeFileSync(join(workspace, "terraform.tfstate"), "next", { mode: 0o600 });
  const api = stateApi(Buffer.from("previous"));
  try {
    await assert.rejects(
      save({
        octokit: api.octokit,
        config: configFor(workspace, { operation: "save" }),
      }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TRS_RESTORE_RECEIPT_REQUIRED",
    );
    assert.equal(api.writeCalls(), 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("save restores previous current after uploaded-state corruption", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-corrupt-upload-"));
  const previous = Buffer.from("previous-state");
  writeFileSync(join(workspace, "terraform.tfstate"), "next-state", {
    mode: 0o600,
  });
  const api = stateApi(previous, { corruptAssetId: 13 });
  const config = configFor(workspace, { operation: "save" });
  authorizeSave(config, api.assets()[0]);
  try {
    await assert.rejects(
      save({ octokit: api.octokit, config }),
      /failed checksum verification/,
    );
    const current = api
      .assets()
      .find((asset) => asset.name === "terraform.tfstate");
    assert.ok(current);
    assert.deepEqual(api.payloads.get(current.id), previous);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("partial replacement restores a complete prior v0.4 plaintext bundle", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-v04-rollback-"));
  const previous = Buffer.from(
    '{"terraform_version":"1.14.0","serial":7,"lineage":"rollback"}',
  );
  const previousBundle = createBundleData({
    role: "current",
    name: "terraform.tfstate",
    stored: previous,
    plaintext: previous,
    encryptionMode: "none",
    encryptionKeyFingerprint: null,
    parentMarker: null,
    parentStoredSha256: null,
    sourceCommit: "previous",
    workflowRunId: "previous",
    actionVersion: "v0.4.0",
    createdAt: "2026-07-28T12:00:00.000Z",
  });
  writeFileSync(join(workspace, "terraform.tfstate"), "next-state", {
    mode: 0o600,
  });
  const api = stateApi(previous, {
    companions: [
      {
        name: "terraform.tfstate.manifest.json",
        data: previousBundle.manifest,
      },
    ],
    failUploadAt: 14,
  });
  const config = configFor(workspace, { operation: "save" });
  authorizeSave(config, api.assets()[0]);
  try {
    await assert.rejects(
      save({ octokit: api.octokit, config }),
      /injected upload failure/,
    );
    const current = new Map(
      api
        .assets()
        .filter((asset) =>
          ["terraform.tfstate", "terraform.tfstate.manifest.json"].includes(
            asset.name,
          ),
        )
        .map((asset) => [asset.name, api.payloads.get(asset.id)]),
    );
    assert.deepEqual(current.get("terraform.tfstate"), previous);
    assert.deepEqual(
      current.get("terraform.tfstate.manifest.json"),
      previousBundle.manifest,
    );
    assert.equal(current.size, 2);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("signed and encrypted storage fail before Release mutation", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-migration-"));
  const state = Buffer.from("age-encryption.org/v1\nencrypted");
  const signature = Buffer.from("signature");
  writeFileSync(join(workspace, "terraform.tfstate"), "next-state", {
    mode: 0o600,
  });
  const api = stateApi(state, {
    companions: [
      { name: "terraform.tfstate.manifest.sig.json", data: signature },
    ],
  });
  const config = configFor(workspace, { operation: "save" });
  authorizeSave(config, api.assets()[0]);
  try {
    await assert.rejects(
      save({ octokit: api.octokit, config }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TRS_V04_MIGRATION_REQUIRED" &&
        /v0\.4\.0/.test(error.message),
    );
    assert.equal(api.writeCalls(), 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("successful plaintext save preserves digest meanings and lifecycle outputs", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-success-"));
  const outputPath = join(workspace, "outputs.txt");
  const next = Buffer.from(
    '{"terraform_version":"1.14.0","serial":2,"lineage":"plain"}',
  );
  writeFileSync(join(workspace, "terraform.tfstate"), next, { mode: 0o600 });
  writeFileSync(outputPath, "", { mode: 0o600 });
  const api = stateApi();
  const config = configFor(workspace, { operation: "save", bootstrap: true });
  authorizeSave(config);
  try {
    await withOutputFile(outputPath, () =>
      save({ octokit: api.octokit, config }),
    );
    const outputs = readFileSync(outputPath, "utf8");
    assert.equal(outputValue(outputs, "stored-state-sha256"), digest(next));
    assert.equal(outputValue(outputs, "plaintext-state-sha256"), digest(next));
    assert.equal(outputValue(outputs, "state-sha256"), digest(next));
    assert.equal(outputValue(outputs, "signature-status"), "unsigned");
    assert.equal(outputValue(outputs, "state-write-committed"), "true");
    assert.equal(outputValue(outputs, "state-phase"), "complete");
    assert.equal(outputValue(outputs, "state-status"), "success");
    assert.notEqual(outputValue(outputs, "remote-state-marker"), "absent");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("post-commit retention failure still exposes the authoritative marker", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-maintenance-"));
  const outputPath = join(workspace, "outputs.txt");
  const previous = Buffer.from("previous-state");
  writeFileSync(join(workspace, "terraform.tfstate"), "next-state", {
    mode: 0o600,
  });
  writeFileSync(outputPath, "", { mode: 0o600 });
  const api = stateApi(previous, { failDeleteId: 12 });
  const config = configFor(workspace, {
    operation: "save",
    backupRetention: 0,
  });
  authorizeSave(config, api.assets()[0]);
  try {
    await assert.rejects(
      withOutputFile(outputPath, () => save({ octokit: api.octokit, config })),
      /committed and verified.*maintenance failed/,
    );
    const outputs = readFileSync(outputPath, "utf8");
    assert.equal(outputValue(outputs, "state-write-committed"), "true");
    assert.equal(outputValue(outputs, "state-phase"), "maintenance");
    assert.equal(outputValue(outputs, "state-status"), "maintenance-failed");
    assert.notEqual(outputValue(outputs, "remote-state-marker"), "absent");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
