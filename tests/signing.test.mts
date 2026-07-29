import { strict as assert } from "node:assert";
import { generateKeyPairSync } from "node:crypto";
import { test } from "node:test";

const {
  createManifestSignature,
  publicKeyInputFromPrivateKey,
  readSigningConfig,
  verifyManifestSignature,
} = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/signing.mjs"
);

test("Ed25519 signatures verify canonical manifest bytes with rotation keys", () => {
  const pair = generateKeyPairSync("ed25519");
  const privateKey = pair.privateKey.export({
    format: "pem",
    type: "pkcs8",
  }) as string;
  const publicKey = publicKeyInputFromPrivateKey(privateKey);
  const config = readSigningConfig("save", "require", privateKey, publicKey);
  const manifest = Buffer.from('{"manifest":"canonical"}\n');
  const signature = createManifestSignature(
    "terraform.tfstate.manifest.json",
    manifest,
    config,
  );
  assert.ok(signature);
  assert.equal(
    verifyManifestSignature(
      "terraform.tfstate.manifest.json",
      manifest,
      signature,
      config,
    ).status,
    "verified",
  );
  assert.throws(
    () =>
      verifyManifestSignature(
        "terraform.tfstate.manifest.json",
        Buffer.from("tampered"),
        signature,
        config,
      ),
    /invalid/,
  );
});
