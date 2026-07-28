import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const {
  createManifestSignature,
  parseManifestSignature,
  publicKeyInputFromPrivateKey,
  readSigningConfig,
  serializeManifestSignature,
  verifyManifestSignature,
} = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/signing.mjs"
);

function keys() {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
  return {
    privateKey,
    publicKey: publicKeyInputFromPrivateKey(privateKey),
  };
}

test("signature serializer is canonical and matches the golden fixture", () => {
  const fixture = readFileSync("tests/fixtures/manifest-signature-v1.json");
  const parsed = parseManifestSignature(fixture);
  assert.deepEqual(serializeManifestSignature(parsed), fixture);
  assert.throws(
    () => serializeManifestSignature({ ...parsed, extra: true } as never),
    /invalid/i,
  );
  const noncanonical = Buffer.from(`${JSON.stringify(parsed)}\n`);
  assert.throws(() => parseManifestSignature(noncanonical), /canonical/);
});

test("Ed25519 policy matrix verifies signing and key rotation", () => {
  const first = keys();
  const second = keys();
  const manifest = readFileSync("tests/fixtures/manifest-v1.json");
  const signing = readSigningConfig(
    "save",
    "require",
    first.privateKey,
    `${second.publicKey}\n${first.publicKey}`,
  );
  const signature = createManifestSignature(
    "terraform.tfstate.manifest.json",
    manifest,
    signing,
  );
  assert.ok(signature);
  assert.equal(
    verifyManifestSignature(
      "terraform.tfstate.manifest.json",
      manifest,
      signature,
      signing,
    ).status,
    "verified",
  );
  assert.throws(
    () =>
      verifyManifestSignature(
        "terraform.tfstate.manifest.json",
        Buffer.concat([manifest, Buffer.from("tampered")]),
        signature,
        signing,
      ),
    /invalid/,
  );
  const wrong = readSigningConfig(
    "restore",
    "allow-unsigned",
    "",
    second.publicKey,
  );
  assert.throws(
    () =>
      verifyManifestSignature(
        "terraform.tfstate.manifest.json",
        manifest,
        signature,
        wrong,
      ),
    /No configured verification key/,
  );
});

test("signature policies fail closed for required, signed-without-key, and bad config", () => {
  const pair = keys();
  const manifest = readFileSync("tests/fixtures/manifest-v1.json");
  const signing = readSigningConfig(
    "save",
    "allow-unsigned",
    pair.privateKey,
    pair.publicKey,
  );
  const signature = createManifestSignature(
    "terraform.tfstate.manifest.json",
    manifest,
    signing,
  );
  assert.ok(signature);
  assert.throws(
    () =>
      verifyManifestSignature(
        "terraform.tfstate.manifest.json",
        manifest,
        undefined,
        {
          policy: "require",
          privateKeyPem: "",
          verificationKeys: [pair.publicKey],
        },
      ),
    /unsigned/,
  );
  assert.throws(
    () =>
      verifyManifestSignature(
        "terraform.tfstate.manifest.json",
        manifest,
        signature,
        { policy: "allow-unsigned", privateKeyPem: "", verificationKeys: [] },
      ),
    /requires verification-public-keys/,
  );
  assert.throws(
    () => readSigningConfig("save", "require", "", pair.publicKey),
    /signing-private-key/,
  );
  assert.throws(
    () => readSigningConfig("save", "allow-unsigned", pair.privateKey, ""),
    /must include the public key/,
  );
  assert.throws(
    () =>
      readSigningConfig(
        "restore",
        "allow-unsigned",
        pair.privateKey,
        pair.publicKey,
      ),
    /only for operation=save/,
  );
});
