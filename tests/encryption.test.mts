import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  decryptState,
  encryptState,
  readEncryptionConfig,
  // @ts-expect-error Node's native TypeScript runner resolves this source path directly.
} from "../src/encryption.mts";
import { generateIdentity, identityToRecipient } from "age-encryption";

test("age encryption round-trips state without exposing plaintext", async () => {
  const identity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const config = readEncryptionConfig("age", recipient, identity);
  const plaintext = Buffer.from('{"sensitive":"state"}');
  const ciphertext = await encryptState(config, plaintext);
  assert.notEqual(ciphertext.toString("utf8"), plaintext.toString("utf8"));
  assert.deepEqual(await decryptState(config, ciphertext), plaintext);
});

test("age encryption fails closed for invalid and missing key material", async () => {
  assert.throws(
    () => readEncryptionConfig("age", "not-a-recipient", ""),
    /unsupported key format/,
  );
  assert.throws(
    () => readEncryptionConfig("none", "age1recipient", ""),
    /require encryption=age/,
  );
  const config = readEncryptionConfig("age", "", "");
  await assert.rejects(encryptState(config, Buffer.from("state")), /required/);
});

test("age encryption does not disclose identity errors", async () => {
  const identity = await generateIdentity();
  const wrongIdentity = await generateIdentity();
  const recipient = await identityToRecipient(identity);
  const ciphertext = await encryptState(
    readEncryptionConfig("age", recipient, ""),
    Buffer.from("state"),
  );
  await assert.rejects(
    decryptState(readEncryptionConfig("age", "", wrongIdentity), ciphertext),
    /Unable to decrypt state/,
  );
});
