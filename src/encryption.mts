import { Decrypter, Encrypter } from "age-encryption";
import { failWithCode } from "./errors.mjs";
import type { EncryptionConfig } from "./types.mjs";

function fail(message: string): never {
  failWithCode("TRS_CONFIG_INVALID", message);
}

function lines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

function unique(values: string, label: string, pattern: RegExp): string[] {
  const parsed = lines(values);
  if (parsed.length === 0) fail(`${label} must contain at least one key.`);
  if (parsed.some((value) => !pattern.test(value))) {
    fail(`${label} contains an unsupported key format.`);
  }
  if (new Set(parsed).size !== parsed.length) {
    fail(`${label} must not contain duplicate keys.`);
  }
  return parsed;
}

function parseRecipients(value: string): string[] {
  return unique(value, "age-recipients", /^age1[ac-hj-np-z02-9]+$/);
}

function parseIdentities(value: string): string[] {
  return unique(value, "age-identities", /^AGE-SECRET-KEY-1[AC-HJ-NP-Z02-9]+$/);
}

export function readEncryptionConfig(
  mode: string,
  recipients: string,
  identities: string,
): EncryptionConfig {
  if (!mode || mode === "none") {
    if (recipients || identities) {
      fail("age-recipients and age-identities require encryption=age.");
    }
    return { mode: "none", recipients: [], identities: [] };
  }
  if (mode !== "age") fail("encryption must be none or age.");
  return {
    mode: "age",
    recipients: recipients ? parseRecipients(recipients) : [],
    identities: identities ? parseIdentities(identities) : [],
  };
}

export async function encryptState(
  config: EncryptionConfig,
  plaintext: Buffer,
): Promise<Buffer> {
  if (config.mode === "none") return plaintext;
  if (config.recipients.length === 0) {
    fail("age-recipients is required to save encrypted state.");
  }
  try {
    const encrypter = new Encrypter();
    for (const recipient of config.recipients) {
      encrypter.addRecipient(recipient);
    }
    return Buffer.from(await encrypter.encrypt(plaintext));
  } catch {
    fail("Unable to encrypt state with the configured age recipients.");
  }
}

export async function decryptState(
  config: EncryptionConfig,
  ciphertext: Buffer,
): Promise<Buffer> {
  if (config.mode === "none") return ciphertext;
  if (config.identities.length === 0) {
    failWithCode(
      "TRS_DECRYPTION_FAILED",
      "age-identities is required to restore encrypted state.",
    );
  }
  try {
    const decrypter = new Decrypter();
    for (const identity of config.identities) {
      decrypter.addIdentity(identity);
    }
    return Buffer.from(await decrypter.decrypt(ciphertext));
  } catch {
    failWithCode(
      "TRS_DECRYPTION_FAILED",
      "Unable to decrypt state with the configured age identities.",
    );
  }
}
