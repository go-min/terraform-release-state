import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";

const { readStoredState, restore, save } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-manager.mjs"
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

function expectedMarker(previous: Buffer): string {
  return Buffer.from(
    JSON.stringify({
      id: 1,
      name: "terraform.tfstate",
      digest: "",
      size: previous.length,
      updatedAt: "2026-07-25T10:00:01Z",
    }),
  ).toString("base64url");
}

function assertCurrentState(
  api: ReturnType<typeof saveApi>,
  expectedId: number,
  expectedData: Buffer,
): void {
  const current = api
    .assets()
    .find((asset) => asset.name === "terraform.tfstate");
  assert.equal(current?.id, expectedId);
  assert.deepEqual(api.payloads.get(expectedId), expectedData);
}

function assertLifecycleOutputs(
  contents: string,
  expected: {
    committed: string;
    phase: string;
    status: string;
  },
): void {
  assert.equal(
    outputValue(contents, "state-write-committed"),
    expected.committed,
  );
  assert.equal(outputValue(contents, "state-phase"), expected.phase);
  assert.equal(outputValue(contents, "state-status"), expected.status);
}

function configFor(
  workspace: string,
  statePath: string,
  overrides: Record<string, unknown> = {},
) {
  return {
    operation: "restore",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath,
    bootstrap: false,
    expectedMarker: "",
    backupRetention: 20,
    sourceCommit: "",
    workflowRunId: "",
    resetConfirmation: "",
    encryption: { mode: "none", recipients: [], identities: [] },
    ...overrides,
  } as never;
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

function saveApi(
  previous: Buffer,
  options: {
    corruptAssetId?: number;
    empty?: boolean;
    failRetention?: boolean;
  } = {},
) {
  const release = { id: 1, body: "" };
  let nextAssetId = 10;
  const payloads = new Map<number, Buffer>();
  let assets = options.empty
    ? []
    : [fakeAsset(1, "terraform.tfstate", previous)];
  if (!options.empty) payloads.set(1, previous);
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
        updateRelease: async ({ body }: { body: string }) => ({
          data: { ...release, body },
        }),
        listReleaseAssets: "list",
        deleteReleaseAsset: async ({ asset_id }: { asset_id: number }) => {
          deleted.push(asset_id);
          if (options.failRetention && asset_id === 11) {
            throw Object.assign(new Error("retention unavailable"), {
              status: 503,
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
    deleted,
    payloads,
    assets: () => assets,
  };
}

test("restore and import leave custom Release metadata unchanged with a read-only client", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-read-only-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const state = Buffer.from(
    '{"version":4,"resources":[],"custom":"release-body-preserved"}',
  );
  const release = { id: 1, body: "operator-owned release notes" };
  const storedAsset = fakeAsset(2, "terraform.tfstate", state);
  let releaseBody = release.body;
  let writeCalls = 0;
  const octokit = {
    paginate: async () => [storedAsset],
    request: async () => ({ data: state }),
    rest: {
      repos: {
        getReleaseByTag: async () => ({
          data: { ...release, body: releaseBody },
        }),
        listReleaseAssets: "list",
        createRelease: async () => {
          writeCalls += 1;
          throw new Error("read-only token must not create a Release");
        },
        updateRelease: async () => {
          writeCalls += 1;
          releaseBody = "changed";
          throw new Error("read-only token must not update a Release");
        },
      },
    },
  } as never;
  const config = configFor(workspace, statePath);

  try {
    await restore({ octokit, config });
    assert.deepEqual(await readStoredState({ octokit, config }), state);
    assert.equal(readFileSync(statePath, "utf8"), state.toString("utf8"));
    assert.equal(releaseBody, "operator-owned release notes");
    assert.equal(writeCalls, 0);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("restore refuses orphan current metadata even with bootstrap", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-restore-"),
  );
  const config = {
    operation: "restore",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath: join(workspace, "terraform.tfstate"),
    bootstrap: true,
    expectedMarker: "",
    backupRetention: 20,
    sourceCommit: "",
    workflowRunId: "",
    resetConfirmation: "",
    encryption: { mode: "age", recipients: [], identities: [] },
  } as never;
  const octokit = {
    paginate: async () => [
      {
        id: 2,
        name: "terraform.tfstate.metadata.json",
        state: "uploaded",
      },
    ],
    rest: {
      repos: {
        getReleaseByTag: async () => ({ data: { id: 1, body: "" } }),
        updateRelease: async ({ body }: { body: string }) => ({
          data: { id: 1, body },
        }),
        listReleaseAssets: "list",
      },
    },
  } as never;

  try {
    await assert.rejects(
      restore({ octokit, config }),
      /metadata asset still exists/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("save restores the previous current state when upload verification fails", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-save-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const previous = Buffer.from("previous-state");
  const next = Buffer.from("next-state");
  writeFileSync(statePath, next, { mode: 0o600 });

  const api = saveApi(previous, { corruptAssetId: 12 });
  const config = configFor(workspace, statePath, {
    operation: "save",
    expectedMarker: expectedMarker(previous),
  });

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
    assert.equal(readFileSync(statePath, "utf8"), "next-state");
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("save does not replace current state when backup verification fails", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-backup-corrupt-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const previous = Buffer.from("previous-state");
  writeFileSync(statePath, "next-state", { mode: 0o600 });
  const api = saveApi(previous, { corruptAssetId: 10 });
  const config = configFor(workspace, statePath, {
    operation: "save",
    expectedMarker: expectedMarker(previous),
  });

  try {
    await assert.rejects(
      save({ octokit: api.octokit, config }),
      /Backup state asset .* failed checksum verification/,
    );
    const current = api
      .assets()
      .find((asset) => asset.name === "terraform.tfstate");
    assert.equal(current?.id, 1);
    assert.deepEqual(api.payloads.get(1), previous);
    assert.equal(api.deleted.includes(1), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("successful encrypted save exposes distinct stored and plaintext digests", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-encrypted-outputs-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const outputPath = join(workspace, "outputs.txt");
  const plaintext = Buffer.from(
    '{"version":4,"serial":1,"sensitive":"encrypted-output-test"}',
  );
  writeFileSync(statePath, plaintext, { mode: 0o600 });
  writeFileSync(outputPath, "", { mode: 0o600 });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const api = saveApi(Buffer.alloc(0), { empty: true });
  const config = configFor(workspace, statePath, {
    operation: "save",
    bootstrap: true,
    expectedMarker: "absent",
    encryption: { mode: "age", recipients: [recipient], identities: [] },
  });

  try {
    await withOutputFile(outputPath, () =>
      save({ octokit: api.octokit, config }),
    );
    const ciphertext = api.payloads.get(10);
    assert.ok(ciphertext);
    assert.notDeepEqual(ciphertext, plaintext);
    const outputs = readFileSync(outputPath, "utf8");
    const storedDigest = outputValue(outputs, "stored-state-sha256");
    const plaintextDigest = outputValue(outputs, "plaintext-state-sha256");
    assert.equal(storedDigest, digest(ciphertext));
    assert.equal(plaintextDigest, digest(plaintext));
    assert.equal(outputValue(outputs, "state-sha256"), digest(plaintext));
    assert.notEqual(storedDigest, plaintextDigest);
    assertLifecycleOutputs(outputs, {
      committed: "true",
      phase: "complete",
      status: "success",
    });
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("save exposes committed state when post-commit retention fails", async (context) => {
  context.mock.method(globalThis, "setTimeout", (callback: () => void) => {
    callback();
    return {} as NodeJS.Timeout;
  });
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-maintenance-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const outputPath = join(workspace, "outputs.txt");
  const previous = Buffer.from("previous-state");
  const next = Buffer.from("next-state");
  writeFileSync(statePath, next, { mode: 0o600 });
  writeFileSync(outputPath, "", { mode: 0o600 });
  const api = saveApi(previous, { failRetention: true });
  const config = configFor(workspace, statePath, {
    operation: "save",
    backupRetention: 0,
    expectedMarker: expectedMarker(previous),
  });

  try {
    await assert.rejects(
      withOutputFile(outputPath, () => save({ octokit: api.octokit, config })),
      /State save committed and verified, but post-commit backup maintenance failed/,
    );
    assertCurrentState(api, 12, next);
    const outputs = readFileSync(outputPath, "utf8");
    assertLifecycleOutputs(outputs, {
      committed: "true",
      phase: "maintenance",
      status: "maintenance-failed",
    });
    assert.equal(outputValue(outputs, "stored-state-sha256"), digest(next));
    assert.equal(outputValue(outputs, "plaintext-state-sha256"), digest(next));
    assert.equal(outputValue(outputs, "state-sha256"), digest(next));
    assert.ok(outputValue(outputs, "remote-state-marker"));
    assert.equal(outputValue(outputs, "backup-count"), undefined);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
