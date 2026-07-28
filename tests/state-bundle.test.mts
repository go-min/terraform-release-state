import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";

const { createBundleData, loadStateBundle } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-bundle.mjs"
);
const { encryptState } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/encryption.mjs"
);
const { parseManifest, serializeManifest } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/manifest.mjs"
);

function baseConfig(overrides: Record<string, unknown> = {}) {
  return {
    operation: "restore",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace: "/workspace",
    statePath: "/workspace/terraform.tfstate",
    bootstrap: false,
    expectedMarker: "",
    backupRetention: 20,
    sourceCommit: "source",
    workflowRunId: "run",
    resetConfirmation: "",
    encryption: { mode: "none", recipients: [], identities: [] },
    signing: {
      policy: "allow-unsigned",
      privateKeyPem: "",
      verificationKeys: [],
    },
    ...overrides,
  } as never;
}

function remoteBundle(data: {
  state: Buffer;
  metadata?: Buffer;
  manifest: Buffer;
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
  const octokit = {
    request: async (_route: string, request: { asset_id: number }) => ({
      data: payloads.get(request.asset_id),
    }),
  } as never;
  return { assets, octokit, payloads };
}

test("manifest bundle verifies stored and plaintext bytes without legacy fallback", async () => {
  const plaintext = Buffer.from(
    '{"terraform_version":"1.14.0","serial":1,"lineage":"lineage"}',
  );
  const config = baseConfig();
  const context = { octokit: {} as never, config };
  const data = createBundleData(
    {
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
      actionVersion: "v0.4.0",
      createdAt: "2026-07-28T12:00:00.000Z",
    },
    context,
  );
  const remote = remoteBundle(data);
  const loaded = await loadStateBundle(
    { octokit: remote.octokit, config },
    remote.assets as never,
    "terraform.tfstate",
    "current",
    { plaintext: "required" },
  );
  assert.equal(loaded.format, "manifest-v1");
  assert.equal(loaded.storedVerification, "verified");
  assert.equal(loaded.plaintextVerification, "verified");
  assert.deepEqual(loaded.plaintext, plaintext);

  const manifestAsset = remote.assets.find((asset: { name: string }) =>
    asset.name.endsWith(".manifest.json"),
  );
  assert.ok(manifestAsset);
  remote.payloads.set(manifestAsset.id, Buffer.from("{}\n"));
  await assert.rejects(
    loadStateBundle(
      { octokit: remote.octokit, config },
      remote.assets as never,
      "terraform.tfstate",
      "current",
      { plaintext: "required" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_MANIFEST_INVALID",
  );
});

test("manifest bundle detects stored corruption", async () => {
  const plaintext = Buffer.from("expected-state");
  const config = baseConfig();
  const data = createBundleData(
    {
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
      actionVersion: "v0.4.0",
      createdAt: "2026-07-28T12:00:00.000Z",
    },
    { octokit: {} as never, config },
  );
  const remote = remoteBundle(data);
  remote.payloads.set(1, Buffer.from("corrupt-state"));
  await assert.rejects(
    loadStateBundle(
      { octokit: remote.octokit, config },
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

test("encrypted manifest exposes not-performed versus full plaintext verification", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const plaintext = Buffer.from(
    '{"terraform_version":"1.14.0","serial":2,"lineage":"encrypted"}',
  );
  const encryption = {
    mode: "age",
    recipients: [recipient],
    identities: [],
  } as const;
  const ciphertext = await encryptState(encryption, plaintext);
  const config = baseConfig({ encryption });
  const data = createBundleData(
    {
      role: "current",
      name: "terraform.tfstate",
      stored: ciphertext,
      plaintext,
      encryptionMode: "age",
      encryptionKeyFingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parentMarker: null,
      parentStoredSha256: null,
      sourceCommit: "source",
      workflowRunId: "run",
      actionVersion: "v0.4.0",
      createdAt: "2026-07-28T12:00:00.000Z",
    },
    { octokit: {} as never, config },
  );
  const remote = remoteBundle(data);
  const storedOnly = await loadStateBundle(
    { octokit: remote.octokit, config },
    remote.assets as never,
    "terraform.tfstate",
    "current",
    { plaintext: "if-available" },
  );
  assert.equal(storedOnly.storedVerification, "verified");
  assert.equal(storedOnly.plaintextVerification, "not-performed");
  assert.equal(storedOnly.plaintext, undefined);

  const fullConfig = baseConfig({
    encryption: { mode: "age", recipients: [], identities: [identity] },
  });
  const full = await loadStateBundle(
    { octokit: remote.octokit, config: fullConfig },
    remote.assets as never,
    "terraform.tfstate",
    "current",
    { plaintext: "required" },
  );
  assert.equal(full.plaintextVerification, "verified");
  assert.deepEqual(full.plaintext, plaintext);

  const tamperedManifest = parseManifest(data.manifest);
  tamperedManifest.content.plaintext.sha256 =
    "0000000000000000000000000000000000000000000000000000000000000000";
  const tamperedRemote = remoteBundle({
    ...data,
    manifest: serializeManifest(tamperedManifest),
  });
  await assert.rejects(
    loadStateBundle(
      { octokit: tamperedRemote.octokit, config: fullConfig },
      tamperedRemote.assets as never,
      "terraform.tfstate",
      "current",
      { plaintext: "required" },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_PLAINTEXT_DIGEST_MISMATCH",
  );
});

test("legacy age migration requires identities before any mutation", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const plaintext = Buffer.from("legacy-state");
  const encryption = {
    mode: "age",
    recipients: [recipient],
    identities: [],
  } as const;
  const ciphertext = await encryptState(encryption, plaintext);
  const metadata = Buffer.from(
    `${JSON.stringify(
      {
        format_version: 1,
        encryption: "age",
        ciphertext_sha256: createHash("sha256")
          .update(ciphertext)
          .digest("hex"),
        action_version: "v0.3.1",
      },
      null,
      2,
    )}\n`,
  );
  const remote = remoteBundle({
    state: ciphertext,
    metadata,
    manifest: Buffer.from("unused"),
  });
  const manifestAssetIndex = remote.assets.findIndex(
    (asset: { name: string }) => asset.name.endsWith(".manifest.json"),
  );
  remote.assets.splice(manifestAssetIndex, 1);
  await assert.rejects(
    loadStateBundle(
      { octokit: remote.octokit, config: baseConfig({ encryption }) },
      remote.assets as never,
      "terraform.tfstate",
      "current",
      { plaintext: "if-available", legacyMigration: true },
    ),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_LEGACY_MIGRATION_IDENTITY_REQUIRED",
  );
  const loaded = await loadStateBundle(
    {
      octokit: remote.octokit,
      config: baseConfig({
        encryption: {
          mode: "age",
          recipients: [recipient],
          identities: [identity],
        },
      }),
    },
    remote.assets as never,
    "terraform.tfstate",
    "current",
    { plaintext: "if-available", legacyMigration: true },
  );
  assert.equal(loaded.format, "legacy");
  assert.equal(loaded.storedVerification, "verified");
  assert.equal(loaded.plaintextVerification, "authenticated");
  assert.deepEqual(loaded.plaintext, plaintext);
  assert.deepEqual(loaded.warnings, ["TRS_LEGACY_UNSIGNED"]);
});
