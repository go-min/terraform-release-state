import {
  createPrivateKey,
  createPublicKey,
  sign as ed25519Sign,
  verify as ed25519Verify,
  type KeyObject,
} from "node:crypto";
import { failWithCode } from "./errors.mjs";
import { sha256 } from "./integrity.mjs";
import type { SignaturePolicy, SigningConfig } from "./types.mjs";

export const SIGNATURE_DOMAIN =
  "terraform-release-state/manifest-signature/v1\n";

export type ManifestSignature = {
  signature: "terraform-release-state";
  schema_version: 1;
  manifest_name: string;
  algorithm: "Ed25519";
  key_fingerprint: string;
  value: string;
};

export type SignatureVerification = {
  status: "verified" | "unsigned";
  keyFingerprint: string;
};

type VerificationKey = { fingerprint: string; key: KeyObject };
const KEYS = [
  "signature",
  "schema_version",
  "manifest_name",
  "algorithm",
  "key_fingerprint",
  "value",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
function exactKeys(value: Record<string, unknown>): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === KEYS.length &&
    KEYS.every((key) => Object.hasOwn(value, key))
  );
}
function decode(value: string, length: number): Buffer | undefined {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return undefined;
  const decoded = Buffer.from(value, "base64url");
  return decoded.length === length && decoded.toString("base64url") === value
    ? decoded
    : undefined;
}
function fingerprint(raw: Buffer): string {
  return `sha256:${sha256(raw)}`;
}
function rawPublicKey(key: KeyObject): Buffer {
  const jwk = key.export({ format: "jwk" }) as {
    kty?: string;
    crv?: string;
    x?: string;
  };
  const raw =
    jwk.kty === "OKP" && jwk.crv === "Ed25519" && jwk.x
      ? decode(jwk.x, 32)
      : undefined;
  if (!raw)
    failWithCode("TRS_CONFIG_INVALID", "Signing key must be an Ed25519 key.");
  return raw;
}
function parseVerificationKey(encoded: string): VerificationKey {
  const match = /^ed25519:([A-Za-z0-9_-]+)$/.exec(encoded);
  const raw = match ? decode(match[1], 32) : undefined;
  if (!raw) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "verification-public-keys contains an unsupported key format; expected ed25519:<base64url-raw-32-byte-key>.",
    );
  }
  return {
    fingerprint: fingerprint(raw),
    key: createPublicKey({
      key: { kty: "OKP", crv: "Ed25519", x: raw.toString("base64url") },
      format: "jwk",
    }),
  };
}
function parsePrivateKey(pem: string): {
  key: KeyObject;
  publicKey: KeyObject;
  publicEncoded: string;
} {
  let key: KeyObject;
  try {
    key = createPrivateKey({ key: pem, format: "pem", type: "pkcs8" });
  } catch {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "signing-private-key must be an unencrypted PKCS#8 PEM Ed25519 private key.",
    );
  }
  if (key.asymmetricKeyType !== "ed25519") {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "signing-private-key must contain an Ed25519 private key.",
    );
  }
  const publicKey = createPublicKey(pem);
  const raw = rawPublicKey(publicKey);
  return {
    key,
    publicKey,
    publicEncoded: `ed25519:${raw.toString("base64url")}`,
  };
}
function nonCommentLines(value: string): string[] {
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("#"));
}

export function readSigningConfig(
  operation: "restore" | "save" | "reset" | "import",
  policyInput: string,
  privateKeyPem: string,
  verificationKeysInput: string,
): SigningConfig {
  const policy = (policyInput || "allow-unsigned") as SignaturePolicy;
  if (policy !== "allow-unsigned" && policy !== "require") {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "signature-policy must be allow-unsigned or require.",
    );
  }
  if (privateKeyPem && operation !== "save" && operation !== "reset") {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "signing-private-key is accepted only for operation=save or exact reset promotion.",
    );
  }
  const verificationKeys = nonCommentLines(verificationKeysInput);
  if (new Set(verificationKeys).size !== verificationKeys.length) {
    failWithCode(
      "TRS_CONFIG_INVALID",
      "verification-public-keys must not contain duplicate keys.",
    );
  }
  for (const key of verificationKeys) parseVerificationKey(key);
  if (policy === "require" && verificationKeys.length === 0) {
    failWithCode(
      "TRS_VERIFICATION_KEY_REQUIRED",
      "signature-policy=require needs at least one verification-public-keys entry.",
    );
  }
  if (operation === "save" && policy === "require" && !privateKeyPem) {
    failWithCode(
      "TRS_SIGNATURE_REQUIRED",
      "signature-policy=require needs signing-private-key for operation=save.",
    );
  }
  if (privateKeyPem) {
    const { publicEncoded } = parsePrivateKey(privateKeyPem);
    if (!verificationKeys.includes(publicEncoded)) {
      failWithCode(
        "TRS_VERIFICATION_KEY_REQUIRED",
        "verification-public-keys must include the public key matching signing-private-key.",
      );
    }
  }
  return { policy, privateKeyPem, verificationKeys };
}

function canonical(value: ManifestSignature): ManifestSignature {
  return {
    signature: value.signature,
    schema_version: value.schema_version,
    manifest_name: value.manifest_name,
    algorithm: value.algorithm,
    key_fingerprint: value.key_fingerprint,
    value: value.value,
  };
}
function validate(value: unknown): ManifestSignature {
  if (
    !record(value) ||
    !exactKeys(value) ||
    value.signature !== "terraform-release-state" ||
    value.schema_version !== 1 ||
    typeof value.manifest_name !== "string" ||
    !value.manifest_name ||
    value.algorithm !== "Ed25519" ||
    typeof value.key_fingerprint !== "string" ||
    !/^sha256:[a-f0-9]{64}$/.test(value.key_fingerprint) ||
    typeof value.value !== "string" ||
    !decode(value.value, 64)
  ) {
    failWithCode(
      "TRS_SIGNATURE_INVALID",
      "Manifest signature object has an unsupported or non-canonical format.",
    );
  }
  return value as ManifestSignature;
}
export function serializeManifestSignature(
  signature: ManifestSignature,
): Buffer {
  return Buffer.from(
    `${JSON.stringify(canonical(validate(signature)), null, 2)}\n`,
    "utf8",
  );
}
export function parseManifestSignature(data: Buffer): ManifestSignature {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    failWithCode(
      "TRS_SIGNATURE_INVALID",
      "Manifest signature asset is not valid UTF-8 JSON.",
    );
  }
  const signature = validate(parsed);
  if (!data.equals(serializeManifestSignature(signature))) {
    failWithCode(
      "TRS_SIGNATURE_INVALID",
      "Manifest signature asset is not in canonical form.",
    );
  }
  return signature;
}
function payload(manifest: Buffer): Buffer {
  return Buffer.concat([Buffer.from(SIGNATURE_DOMAIN, "utf8"), manifest]);
}
export function createManifestSignature(
  name: string,
  manifest: Buffer,
  config: SigningConfig,
): Buffer | undefined {
  if (!config.privateKeyPem) return undefined;
  const { key, publicKey } = parsePrivateKey(config.privateKeyPem);
  const raw = rawPublicKey(publicKey);
  return serializeManifestSignature({
    signature: "terraform-release-state",
    schema_version: 1,
    manifest_name: name,
    algorithm: "Ed25519",
    key_fingerprint: fingerprint(raw),
    value: ed25519Sign(null, payload(manifest), key).toString("base64url"),
  });
}
export function verifyManifestSignature(
  name: string,
  manifest: Buffer,
  signatureBytes: Buffer | undefined,
  config: SigningConfig,
): SignatureVerification {
  if (!signatureBytes) {
    if (config.policy === "require")
      failWithCode(
        "TRS_SIGNATURE_REQUIRED",
        `Manifest ${name} is unsigned but signature-policy=require.`,
      );
    return { status: "unsigned", keyFingerprint: "" };
  }
  const signature = parseManifestSignature(signatureBytes);
  if (signature.manifest_name !== name)
    failWithCode(
      "TRS_SIGNATURE_INVALID",
      `Manifest signature names ${signature.manifest_name}, not ${name}.`,
    );
  if (config.verificationKeys.length === 0)
    failWithCode(
      "TRS_VERIFICATION_KEY_REQUIRED",
      `Signed manifest ${name} requires verification-public-keys.`,
    );
  const selected = config.verificationKeys
    .map(parseVerificationKey)
    .find((key) => key.fingerprint === signature.key_fingerprint);
  if (!selected)
    failWithCode(
      "TRS_SIGNATURE_KEY_UNKNOWN",
      `No configured verification key matches ${signature.key_fingerprint}.`,
    );
  const value = decode(signature.value, 64);
  if (!value || !ed25519Verify(null, payload(manifest), selected.key, value))
    failWithCode(
      "TRS_SIGNATURE_INVALID",
      `Manifest signature for ${name} is invalid.`,
    );
  return { status: "verified", keyFingerprint: selected.fingerprint };
}
export function publicKeyInputFromPrivateKey(privateKeyPem: string): string {
  return parsePrivateKey(privateKeyPem).publicEncoded;
}
