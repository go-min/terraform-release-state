import { strict as assert } from "node:assert";
import { createHash, generateKeyPairSync } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";

const { readStoredState, restore, save } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-manager.mjs"
);
const { publicKeyInputFromPrivateKey } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/signing.mjs"
);
const { createBundleData } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-bundle.mjs"
);
const { ageRecipientsFingerprint } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/manifest.mjs"
);
const { encryptState } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/encryption.mjs"
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
    failUploadAt?: number;
    initialCompanions?: Array<{ name: string; data: Buffer }>;
  } = {},
) {
  const release = { id: 1, body: "" };
  let nextAssetId = 10;
  const payloads = new Map<number, Buffer>();
  let assets = options.empty
    ? []
    : [fakeAsset(1, "terraform.tfstate", previous)];
  if (!options.empty) payloads.set(1, previous);
  if (!options.empty && options.initialCompanions) {
    for (const companion of options.initialCompanions) {
      const id = assets.length + 1;
      assets.push(fakeAsset(id, companion.name, companion.data));
      payloads.set(id, companion.data);
    }
  }
  const deleted: number[] = [];
  let uploadFailed = false;
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
      /companion terraform\.tfstate\.metadata\.json exists/,
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

  const api = saveApi(previous, { corruptAssetId: 13 });
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

test("save recovers previous state after a partial current bundle upload", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-partial-current-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const previous = Buffer.from("previous-state");
  writeFileSync(statePath, "next-state", { mode: 0o600 });
  const api = saveApi(previous, { failUploadAt: 14 });
  const config = configFor(workspace, statePath, {
    operation: "save",
    expectedMarker: expectedMarker(previous),
  });

  try {
    await assert.rejects(
      save({ octokit: api.octokit, config }),
      /injected upload failure/,
    );
    const current = api
      .assets()
      .find((asset) => asset.name === "terraform.tfstate");
    assert.ok(current);
    assert.deepEqual(api.payloads.get(current.id), previous);
    assert.equal(
      api
        .assets()
        .some((asset) => asset.name === "terraform.tfstate.manifest.json"),
      false,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("save recovers a complete signed encrypted v0.4 bundle after partial replacement", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-v04-recovery-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const previousPlaintext = Buffer.from(
    '{"terraform_version":"1.14.0","serial":7,"lineage":"rollback"}',
  );
  const nextPlaintext = Buffer.from(
    '{"terraform_version":"1.14.0","serial":8,"lineage":"rollback"}',
  );
  writeFileSync(statePath, nextPlaintext, { mode: 0o600 });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
  const publicKey = publicKeyInputFromPrivateKey(privateKeyPem);
  const signing = {
    policy: "require",
    privateKeyPem,
    verificationKeys: [publicKey],
  } as const;
  const encryption = {
    mode: "age",
    recipients: [recipient],
    identities: [identity],
  } as const;
  const previousStored = await encryptState(encryption, previousPlaintext);
  const manifestContext = {
    octokit: {} as never,
    config: configFor(workspace, statePath, { signing, encryption }),
  };
  const previousBundle = createBundleData(
    {
      role: "current",
      name: "terraform.tfstate",
      stored: previousStored,
      plaintext: previousPlaintext,
      encryptionMode: "age",
      encryptionKeyFingerprint: ageRecipientsFingerprint([recipient]),
      parentMarker: null,
      parentStoredSha256: null,
      sourceCommit: "previous-commit",
      workflowRunId: "previous-run",
      actionVersion: "v0.4.0",
      createdAt: "2026-07-28T12:00:00.000Z",
    },
    manifestContext,
  );
  assert.ok(previousBundle.metadata);
  assert.ok(previousBundle.signature);
  const api = saveApi(previousStored, {
    failUploadAt: 17,
    initialCompanions: [
      {
        name: "terraform.tfstate.metadata.json",
        data: previousBundle.metadata,
      },
      {
        name: "terraform.tfstate.manifest.sig.json",
        data: previousBundle.signature,
      },
      {
        name: "terraform.tfstate.manifest.json",
        data: previousBundle.manifest,
      },
    ],
  });
  const config = configFor(workspace, statePath, {
    operation: "save",
    expectedMarker: expectedMarker(previousStored),
    encryption,
    signing,
  });

  try {
    await assert.rejects(
      save({ octokit: api.octokit, config }),
      /injected upload failure/,
    );
    assert.deepEqual(
      api.deleted,
      [3, 4, 2, 1, 16, 15, 14],
      "the old signed bundle must be fully deleted before the replacement manifest fails, then every partial replacement companion must be removed",
    );
    const current = new Map(
      api
        .assets()
        .filter(
          (asset) =>
            asset.name === "terraform.tfstate" ||
            asset.name.startsWith("terraform.tfstate.manifest") ||
            asset.name === "terraform.tfstate.metadata.json",
        )
        .map((asset) => [asset.name, api.payloads.get(asset.id)]),
    );
    assert.deepEqual(current.get("terraform.tfstate"), previousStored);
    assert.deepEqual(
      current.get("terraform.tfstate.metadata.json"),
      previousBundle.metadata,
    );
    assert.deepEqual(
      current.get("terraform.tfstate.manifest.sig.json"),
      previousBundle.signature,
    );
    assert.deepEqual(
      current.get("terraform.tfstate.manifest.json"),
      previousBundle.manifest,
    );
    assert.equal(current.size, 4);
    assert.deepEqual(
      await readStoredState({
        octokit: api.octokit,
        config: configFor(workspace, statePath, {
          encryption,
          signing: {
            policy: "require",
            privateKeyPem: "",
            verificationKeys: [publicKey],
          },
        }),
      }),
      previousPlaintext,
    );
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
      /backup state asset .* failed checksum verification/i,
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

test("successful legacy plaintext save migrates current and backup bundles", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-legacy-migrate-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const previous = Buffer.from(
    '{"terraform_version":"1.13.0","serial":1,"lineage":"legacy"}',
  );
  const next = Buffer.from(
    '{"terraform_version":"1.14.0","serial":2,"lineage":"legacy"}',
  );
  writeFileSync(statePath, next, { mode: 0o600 });
  const api = saveApi(previous);
  const config = configFor(workspace, statePath, {
    operation: "save",
    expectedMarker: expectedMarker(previous),
  });

  try {
    await save({ octokit: api.octokit, config });
    const names = api.assets().map((asset) => asset.name);
    const backup = names.find(
      (name) =>
        name.startsWith("terraform.tfstate.backup-") && !name.endsWith(".json"),
    );
    assert.ok(backup);
    assert.ok(names.includes(`${backup}.metadata.json`));
    assert.ok(names.includes(`${backup}.manifest.json`));
    assert.ok(names.includes("terraform.tfstate.manifest.json"));
    assert.equal(names.includes("terraform.tfstate.metadata.json"), false);
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

test("signed save and read verify the manifest with a rotation key set", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-signed-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const outputPath = join(workspace, "outputs.txt");
  const state = Buffer.from(
    '{"terraform_version":"1.14.0","serial":4,"lineage":"signed"}',
  );
  writeFileSync(statePath, state, { mode: 0o600 });
  writeFileSync(outputPath, "", { mode: 0o600 });
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
  const publicKey = publicKeyInputFromPrivateKey(privateKeyPem);
  const rotated = generateKeyPairSync("ed25519").publicKey.export({
    format: "jwk",
  }) as { x: string };
  const api = saveApi(Buffer.alloc(0), { empty: true });
  const saveConfig = configFor(workspace, statePath, {
    operation: "save",
    bootstrap: true,
    expectedMarker: "absent",
    signing: {
      policy: "require",
      privateKeyPem,
      verificationKeys: [`ed25519:${rotated.x}`, publicKey],
    },
  });

  try {
    await withOutputFile(outputPath, () =>
      save({ octokit: api.octokit, config: saveConfig }),
    );
    const outputs = readFileSync(outputPath, "utf8");
    assert.equal(outputValue(outputs, "storage-format"), "manifest-v1");
    assert.equal(outputValue(outputs, "signature-status"), "verified");
    assert.match(
      outputValue(outputs, "signature-key-fingerprint") || "",
      /^sha256:[a-f0-9]{64}$/,
    );
    assert.equal(outputValue(outputs, "stored-state-verification"), "verified");
    assert.equal(
      outputValue(outputs, "plaintext-state-verification"),
      "verified",
    );
    const restored = await readStoredState({
      octokit: api.octokit,
      config: configFor(workspace, statePath, {
        signing: {
          policy: "require",
          privateKeyPem: "",
          verificationKeys: [publicKey],
        },
      }),
    });
    assert.deepEqual(restored, state);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("signed current signature corruption fails verification and cleans bootstrap bundle", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-signature-corrupt-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  writeFileSync(statePath, "signed-state", { mode: 0o600 });
  const pair = generateKeyPairSync("ed25519");
  const privateKeyPem = pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
  const publicKey = publicKeyInputFromPrivateKey(privateKeyPem);
  const api = saveApi(Buffer.alloc(0), { empty: true, corruptAssetId: 11 });
  const config = configFor(workspace, statePath, {
    operation: "save",
    bootstrap: true,
    expectedMarker: "absent",
    signing: {
      policy: "require",
      privateKeyPem,
      verificationKeys: [publicKey],
    },
  });
  try {
    await assert.rejects(
      save({ octokit: api.octokit, config }),
      /signature asset failed checksum verification/,
    );
    assert.deepEqual(
      api
        .assets()
        .filter((asset) => asset.name.startsWith("terraform.tfstate")),
      [],
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("legacy age migration fails before any Release mutation without identities", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-migration-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  writeFileSync(statePath, "next-state", { mode: 0o600 });
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const previous = await encryptState(
    { mode: "age", recipients: [recipient], identities: [] },
    Buffer.from("previous-state"),
  );
  const metadata = Buffer.from(
    `${JSON.stringify(
      {
        format_version: 1,
        encryption: "age",
        ciphertext_sha256: digest(previous),
        action_version: "v0.3.1",
      },
      null,
      2,
    )}\n`,
  );
  const stateAsset = fakeAsset(1, "terraform.tfstate", previous);
  const metadataAsset = fakeAsset(
    2,
    "terraform.tfstate.metadata.json",
    metadata,
  );
  let writeCalls = 0;
  const octokit = {
    paginate: async () => [stateAsset, metadataAsset],
    request: async (_route: string, request: { asset_id: number }) => ({
      data: request.asset_id === 1 ? previous : metadata,
    }),
    rest: {
      repos: {
        getReleaseByTag: async () => ({ data: { id: 1, body: "custom" } }),
        listReleaseAssets: "list",
        updateRelease: async () => {
          writeCalls += 1;
          throw new Error("must not update before migration validation");
        },
        uploadReleaseAsset: async () => {
          writeCalls += 1;
          throw new Error("must not upload before migration validation");
        },
        deleteReleaseAsset: async () => {
          writeCalls += 1;
          throw new Error("must not delete before migration validation");
        },
      },
    },
  } as never;
  const config = configFor(workspace, statePath, {
    operation: "save",
    expectedMarker: expectedMarker(previous),
    encryption: { mode: "age", recipients: [recipient], identities: [] },
  });

  try {
    await assert.rejects(
      save({ octokit, config }),
      (error: unknown) =>
        error instanceof Error &&
        "code" in error &&
        error.code === "TRS_LEGACY_MIGRATION_IDENTITY_REQUIRED",
    );
    assert.equal(writeCalls, 0);
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
    assertCurrentState(api, 13, next);
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
