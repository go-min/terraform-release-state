import { sha256 } from "./integrity.mjs";
import { failWithCode } from "./errors.mjs";
import type { EncryptionMode } from "./manifest.mjs";

export type StateMetadata = {
  format_version: 1;
  encryption: "age";
  ciphertext_sha256: string;
  action_version: string;
};

export type BackupMetadata = {
  timestamp_utc: string;
  source_commit: string;
  workflow_run_id: string;
  action_version: string;
  current_asset: string;
  encryption: EncryptionMode;
  sha256: string;
};

function fail(message: string): never {
  failWithCode("TRS_OBJECT_SET_INCOMPLETE", message);
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
    if (data.length > 0)
      fail("Current state metadata requires encryption=age.");
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
    failWithCode(
      "TRS_STORED_DIGEST_MISMATCH",
      "Current state metadata checksum does not match the state asset.",
    );
  }
  return metadata;
}

export function createBackupMetadata(input: {
  stored: Buffer;
  currentAsset: string;
  encryption: EncryptionMode;
  sourceCommit: string;
  workflowRunId: string;
  actionVersion: string;
  createdAt?: string;
}): Buffer {
  return Buffer.from(
    `${JSON.stringify(
      {
        timestamp_utc: input.createdAt || new Date().toISOString(),
        source_commit: input.sourceCommit || "unknown",
        workflow_run_id: input.workflowRunId || "unknown",
        action_version: input.actionVersion || "unknown",
        current_asset: input.currentAsset,
        encryption: input.encryption,
        sha256: sha256(input.stored),
      } satisfies BackupMetadata,
      null,
      2,
    )}\n`,
  );
}

export function parseBackupMetadata(
  data: Buffer,
  currentAsset: string,
  mode: EncryptionMode,
  stored: Buffer,
): BackupMetadata {
  let metadata: BackupMetadata;
  try {
    metadata = JSON.parse(data.toString("utf8")) as BackupMetadata;
  } catch {
    fail("Backup metadata is invalid.");
  }
  if (
    typeof metadata.timestamp_utc !== "string" ||
    Number.isNaN(Date.parse(metadata.timestamp_utc)) ||
    typeof metadata.source_commit !== "string" ||
    typeof metadata.workflow_run_id !== "string" ||
    typeof metadata.action_version !== "string" ||
    metadata.current_asset !== currentAsset ||
    metadata.encryption !== mode ||
    typeof metadata.sha256 !== "string" ||
    !/^[a-f0-9]{64}$/.test(metadata.sha256)
  ) {
    fail("Backup metadata has an unsupported format or binding.");
  }
  if (metadata.sha256 !== sha256(stored)) {
    failWithCode(
      "TRS_STORED_DIGEST_MISMATCH",
      "Backup metadata checksum does not match the state asset.",
    );
  }
  return metadata;
}
