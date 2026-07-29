import { strict as assert } from "node:assert";
import { test } from "node:test";
import { generateIdentity, identityToRecipient } from "age-encryption";

const { decryptState, encryptState, readEncryptionConfig } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/encryption.mjs"
);

test("age encryption round-trips state and keeps stored bytes distinct", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const config = readEncryptionConfig("age", recipient, identity);
  const plaintext = Buffer.from('{"sensitive":"state"}');
  const ciphertext = await encryptState(config, plaintext);
  assert.notDeepEqual(ciphertext, plaintext);
  assert.deepEqual(await decryptState(config, ciphertext), plaintext);
});

test("age decryption distinguishes missing identities from digest failures", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const ciphertext = await encryptState(
    readEncryptionConfig("age", recipient, ""),
    Buffer.from("state"),
  );
  await assert.rejects(
    decryptState(readEncryptionConfig("age", "", ""), ciphertext),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_DECRYPTION_FAILED",
  );
});
