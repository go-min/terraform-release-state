import { sha256 } from "./integrity.mjs";
import type { EncryptionMode } from "./types.mjs";

type StateMetadata = {
  format_version: 1;
  encryption: "age";
  ciphertext_sha256: string;
  action_version: string;
};

function fail(message: string): never {
  throw new Error(message);
}

export function createStateMetadata(ciphertext: Buffer): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        format_version: 1,
        encryption: "age",
        ciphertext_sha256: sha256(ciphertext),
        action_version: process.env.GITHUB_ACTION_REF || "unknown",
      } satisfies StateMetadata,
      null,
      2,
    )}\n`,
  );
}

export function parseStateMetadata(
  data: Buffer,
  mode: EncryptionMode,
  ciphertext: Buffer,
): StateMetadata | undefined {
  if (mode === "none") {
    if (data.length > 0) {
      fail("Current state metadata requires encryption=age.");
    }
    return undefined;
  }
  let metadata: StateMetadata;
  try {
    metadata = JSON.parse(data.toString("utf8")) as StateMetadata;
  } catch {
    fail("Current state metadata is invalid.");
  }
  if (
    metadata.format_version !== 1 ||
    metadata.encryption !== "age" ||
    typeof metadata.ciphertext_sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.ciphertext_sha256) ||
    typeof metadata.action_version !== "string"
  ) {
    fail("Current state metadata has an unsupported format.");
  }
  if (metadata.ciphertext_sha256 !== sha256(ciphertext)) {
    fail("Current state metadata checksum does not match the state asset.");
  }
  return metadata;
}
