import { strict as assert } from "node:assert";
import { test } from "node:test";

const { assertNoUnsupportedStorage, createBundleData, loadStateBundle } =
  await import(
    // @ts-expect-error This source module is compiled into the temporary native-test build.
    "../.test-build/src/state-bundle.mjs"
  );
const { createManifest, parseManifest, serializeManifest } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/manifest.mjs"
);

function baseConfig() {
  return {
    operation: "restore",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace: "/workspace",
    statePath: "/workspace/terraform.tfstate",
    receiptPath: "/runner/receipt.json",
    bootstrap: false,
    backupRetention: 20,
    sourceCommit: "source",
    workflowRunId: "run",
    resetTarget: "all",
  } as never;
}

function bundleData(plaintext = Buffer.from("state")) {
  return createBundleData({
    role: "current",
    name: "terraform.tfstate",
    stored: plaintext,
    plaintext,
    encryptionMode: "none",
    encryptionKeyFingerprint: null,
    parentMarker: null,
    parentStoredSha256: null,
    sourceCommit: "source",
    workflowRunId: "run",
    actionVersion: "v0.5.0",
    createdAt: "2026-07-28T12:00:00.000Z",
  });
}

function remoteBundle(data: {
  state: Buffer;
  metadata?: Buffer;
  manifest?: Buffer;
  signature?: Buffer;
}) {
  const payloads = new Map<number, Buffer>();
  const assets: Array<{
    id: number;
    name: string;
    state: "uploaded";
    size: number;
    digest: string;
    created_at: string;
    updated_at: string;
  }> = [];
  let id = 1;
  for (const [name, payload] of [
    ["terraform.tfstate", data.state],
    ["terraform.tfstate.metadata.json", data.metadata],
    ["terraform.tfstate.manifest.sig.json", data.signature],
    ["terraform.tfstate.manifest.json", data.manifest],
  ] as const) {
    if (!payload) continue;
    payloads.set(id, payload);
    assets.push({
      id,
      name,
      state: "uploaded",
      size: payload.length,
      digest: "",
      created_at: "2026-07-28T12:00:00Z",
      updated_at: "2026-07-28T12:00:00Z",
    });
    id += 1;
  }
  let downloads = 0;
  const octokit = {
    request: async (_route: string, request: { asset_id: number }) => {
      downloads += 1;
      return { data: payloads.get(request.asset_id) };
    },
  } as never;
  return { assets, octokit, payloads, downloads: () => downloads };
}

test("plaintext manifest bundle verifies stored and plaintext bytes", async () => {
  const plaintext = Buffer.from(
    '{"terraform_version":"1.14.0","serial":1,"lineage":"lineage"}',
  );
  const data = bundleData(plaintext);
  const remote = remoteBundle(data);
  const loaded = await loadStateBundle(
    { octokit: remote.octokit, config: baseConfig() },
    remote.assets as never,
    "terraform.tfstate",
    "current",
    { plaintext: "required" },
  );
  assert.equal(loaded.format, "manifest-v1");
  assert.equal(loaded.storedVerification, "verified");
  assert.equal(loaded.plaintextVerification, "verified");
  assert.equal(loaded.signature.status, "unsigned");
  assert.deepEqual(loaded.plaintext, plaintext);

  const parsed = parseManifest(data.manifest);
  assert.equal(parsed.content.stored.sha256, parsed.content.plaintext.sha256);
});

test("manifest bundle detects downloaded state corruption", async () => {
  const remote = remoteBundle(bundleData(Buffer.from("expected-state")));
  remote.payloads.set(1, Buffer.from("corrupt-state"));
  await assert.rejects(
    loadStateBundle(
      { octokit: remote.octokit, config: baseConfig() },
      remote.assets as never,
      "terraform.tfstate",
      "current",
      { plaintext: "required" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_STORED_DIGEST_MISMATCH",
  );
});

test("v0.5 refuses to create encrypted or stored/plaintext-divergent bundles", () => {
  const plaintext = Buffer.from("plaintext");
  assert.throws(
    () =>
      createBundleData({
        role: "current",
        name: "terraform.tfstate",
        stored: Buffer.from("ciphertext"),
        plaintext,
        encryptionMode: "age",
        encryptionKeyFingerprint:
          "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
        parentMarker: null,
        parentStoredSha256: null,
        sourceCommit: "source",
        workflowRunId: "run",
        actionVersion: "v0.5.0",
      }),
    /plaintext unsigned/,
  );
});

test("encrypted v0.4 manifest fails with the migration code", async () => {
  const ciphertext = Buffer.from("age-encryption.org/v1\nencrypted");
  const manifest = serializeManifest(
    createManifest({
      role: "current",
      name: "terraform.tfstate",
      stored: ciphertext,
      plaintext: Buffer.from("plaintext"),
      encryptionMode: "age",
      encryptionKeyFingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parentMarker: null,
      parentStoredSha256: null,
      sourceCommit: "source",
      workflowRunId: "run",
      actionVersion: "v0.4.0",
      createdAt: "2026-07-28T12:00:00.000Z",
    }),
  );
  const remote = remoteBundle({ state: ciphertext, manifest });
  await assert.rejects(
    loadStateBundle(
      { octokit: remote.octokit, config: baseConfig() },
      remote.assets as never,
      "terraform.tfstate",
      "current",
      { plaintext: "required" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_V04_MIGRATION_REQUIRED" &&
      /fb529572/.test(error.message),
  );
});

test("signed bundle fails before state or signature bytes are downloaded", async () => {
  const data = bundleData();
  const remote = remoteBundle({ ...data, signature: Buffer.from("signed") });
  await assert.rejects(
    loadStateBundle(
      { octokit: remote.octokit, config: baseConfig() },
      remote.assets as never,
      "terraform.tfstate",
      "current",
      { plaintext: "required" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_V04_MIGRATION_REQUIRED",
  );
  assert.equal(remote.downloads(), 0);
});

test("legacy age metadata and ciphertext are rejected during preflight", async () => {
  const ciphertext = Buffer.from("age-encryption.org/v1\nencrypted");
  const metadata = Buffer.from(
    '{"format_version":1,"encryption":"age","ciphertext_sha256":"0000000000000000000000000000000000000000000000000000000000000000","action_version":"v0.4.0"}\n',
  );
  const remote = remoteBundle({ state: ciphertext, metadata });
  await assert.rejects(
    assertNoUnsupportedStorage(
      { octokit: remote.octokit, config: baseConfig() },
      remote.assets as never,
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_V04_MIGRATION_REQUIRED",
  );
});
