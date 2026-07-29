import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";

const { assertNoUnsupportedStorage, createBundleData, loadStateBundle } =
  await import(
    // @ts-expect-error This source module is compiled into the temporary native-test build.
    "../.test-build/src/state-bundle.mjs"
  );
const { createManifest, parseManifest, serializeManifest } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/manifest.mjs"
);
const { encryptState } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/encryption.mjs"
);
const { publicKeyInputFromPrivateKey } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/signing.mjs"
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

test("v0.6 creates manifests that distinguish encrypted stored and plaintext bytes", () => {
  const plaintext = Buffer.from("plaintext");
  const bundle = createBundleData({
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
  });
  const parsed = parseManifest(bundle.manifest);
  assert.equal(parsed.encryption.mode, "age");
  assert.notEqual(
    parsed.content.stored.sha256,
    parsed.content.plaintext.sha256,
  );
});

test("dual-reads a v0.4 age-encrypted signed manifest bundle", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const plaintext = Buffer.from('{"serial":4,"lineage":"v04"}');
  const stored = await encryptState(
    { mode: "age", recipients: [recipient], identities: [identity] },
    plaintext,
  );
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
  const publicKey = publicKeyInputFromPrivateKey(privateKey);
  const config = {
    ...(baseConfig() as unknown as Record<string, unknown>),
    encryption: {
      mode: "age",
      recipients: [recipient],
      identities: [identity],
    },
    signing: {
      policy: "allow-unsigned",
      privateKeyPem: privateKey,
      verificationKeys: [publicKey],
    },
  };
  const data = createBundleData(
    {
      role: "current",
      name: "terraform.tfstate",
      stored,
      plaintext,
      encryptionMode: "age",
      encryptionKeyFingerprint:
        "sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      parentMarker: null,
      parentStoredSha256: null,
      sourceCommit: "source",
      workflowRunId: "run",
      actionVersion: "v0.4.0",
    },
    { octokit: {} as never, config } as never,
  );
  const remote = remoteBundle(data);
  const loaded = await loadStateBundle(
    { octokit: remote.octokit, config } as never,
    remote.assets as never,
    "terraform.tfstate",
    "current",
    { plaintext: "required" },
  );
  assert.deepEqual(loaded.plaintext, plaintext);
  assert.equal(loaded.signature.status, "verified");
  assert.equal(loaded.storedVerification, "verified");
  assert.equal(loaded.plaintextVerification, "verified");
});

test("encrypted manifests require their compatibility metadata", async () => {
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
      error.code === "TRS_OBJECT_SET_INCOMPLETE",
  );
});

test("invalid signed bundle fails closed", async () => {
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
      error.code === "TRS_SIGNATURE_INVALID",
  );
  assert.ok(remote.downloads() > 0);
});

test("legacy age metadata corruption is rejected during preflight", async () => {
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
      error.code === "TRS_STORED_DIGEST_MISMATCH",
  );
});
