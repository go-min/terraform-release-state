import { failWithCode } from "./errors.mjs";
import { sha256 } from "./integrity.mjs";

export type EncryptionMode = "none" | "age";

export type ObjectRole = "current" | "backup";

export type StateManifest = {
  manifest: "terraform-release-state";
  schema_version: 1;
  object: {
    role: ObjectRole;
    name: string;
  };
  content: {
    stored: {
      sha256: string;
      size_bytes: number;
    };
    plaintext: {
      sha256: string;
      size_bytes: number;
    };
  };
  terraform: {
    version: string | null;
    serial: number | null;
    lineage: string | null;
  };
  parent: {
    remote_state_marker: string | null;
    stored_sha256: string | null;
  };
  encryption: {
    mode: EncryptionMode;
    key_fingerprint: string | null;
  };
  provenance: {
    source_commit: string;
    workflow_run_id: string;
    action_version: string;
    created_at: string;
  };
};

export type ManifestInput = {
  role: ObjectRole;
  name: string;
  stored: Buffer;
  plaintext: Buffer;
  encryptionMode: EncryptionMode;
  encryptionKeyFingerprint: string | null;
  parentMarker: string | null;
  parentStoredSha256: string | null;
  sourceCommit: string;
  workflowRunId: string;
  actionVersion: string;
  createdAt?: string;
};

const ROOT_KEYS = [
  "manifest",
  "schema_version",
  "object",
  "content",
  "terraform",
  "parent",
  "encryption",
  "provenance",
] as const;
const OBJECT_KEYS = ["role", "name"] as const;
const CONTENT_KEYS = ["stored", "plaintext"] as const;
const DIGEST_KEYS = ["sha256", "size_bytes"] as const;
const TERRAFORM_KEYS = ["version", "serial", "lineage"] as const;
const PARENT_KEYS = ["remote_state_marker", "stored_sha256"] as const;
const ENCRYPTION_KEYS = ["mode", "key_fingerprint"] as const;
const PROVENANCE_KEYS = [
  "source_commit",
  "workflow_run_id",
  "action_version",
  "created_at",
] as const;

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function exactKeys(
  value: Record<string, unknown>,
  expected: readonly string[],
): boolean {
  const actual = Object.keys(value);
  return (
    actual.length === expected.length &&
    expected.every((key) => Object.hasOwn(value, key))
  );
}

function digestObject(value: unknown): boolean {
  return (
    record(value) &&
    exactKeys(value, DIGEST_KEYS) &&
    typeof value.sha256 === "string" &&
    /^[a-f0-9]{64}$/.test(value.sha256) &&
    typeof value.size_bytes === "number" &&
    Number.isSafeInteger(value.size_bytes) &&
    value.size_bytes >= 0
  );
}

function nullableString(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0);
}

function canonicalManifest(value: StateManifest): StateManifest {
  return {
    manifest: value.manifest,
    schema_version: value.schema_version,
    object: {
      role: value.object.role,
      name: value.object.name,
    },
    content: {
      stored: {
        sha256: value.content.stored.sha256,
        size_bytes: value.content.stored.size_bytes,
      },
      plaintext: {
        sha256: value.content.plaintext.sha256,
        size_bytes: value.content.plaintext.size_bytes,
      },
    },
    terraform: {
      version: value.terraform.version,
      serial: value.terraform.serial,
      lineage: value.terraform.lineage,
    },
    parent: {
      remote_state_marker: value.parent.remote_state_marker,
      stored_sha256: value.parent.stored_sha256,
    },
    encryption: {
      mode: value.encryption.mode,
      key_fingerprint: value.encryption.key_fingerprint,
    },
    provenance: {
      source_commit: value.provenance.source_commit,
      workflow_run_id: value.provenance.workflow_run_id,
      action_version: value.provenance.action_version,
      created_at: value.provenance.created_at,
    },
  };
}

function validateManifest(value: unknown): StateManifest {
  if (!record(value)) {
    failWithCode("TRS_MANIFEST_INVALID", "State manifest must be an object.");
  }
  if (
    "schema_version" in value &&
    value.schema_version !== 1 &&
    typeof value.schema_version === "number"
  ) {
    failWithCode(
      "TRS_MANIFEST_UNSUPPORTED_VERSION",
      `State manifest schema version ${value.schema_version} is unsupported.`,
    );
  }
  if (
    !exactKeys(value, ROOT_KEYS) ||
    value.manifest !== "terraform-release-state" ||
    value.schema_version !== 1 ||
    !record(value.object) ||
    !exactKeys(value.object, OBJECT_KEYS) ||
    (value.object.role !== "current" && value.object.role !== "backup") ||
    typeof value.object.name !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value.object.name) ||
    !record(value.content) ||
    !exactKeys(value.content, CONTENT_KEYS) ||
    !digestObject(value.content.stored) ||
    !digestObject(value.content.plaintext) ||
    !record(value.terraform) ||
    !exactKeys(value.terraform, TERRAFORM_KEYS) ||
    !(
      value.terraform.version === null ||
      (typeof value.terraform.version === "string" &&
        value.terraform.version.length > 0)
    ) ||
    !(
      value.terraform.serial === null ||
      (typeof value.terraform.serial === "number" &&
        Number.isSafeInteger(value.terraform.serial) &&
        value.terraform.serial >= 0)
    ) ||
    !nullableString(value.terraform.lineage) ||
    !record(value.parent) ||
    !exactKeys(value.parent, PARENT_KEYS) ||
    !nullableString(value.parent.remote_state_marker) ||
    !(
      value.parent.stored_sha256 === null ||
      (typeof value.parent.stored_sha256 === "string" &&
        /^[a-f0-9]{64}$/.test(value.parent.stored_sha256))
    ) ||
    (value.parent.remote_state_marker === null) !==
      (value.parent.stored_sha256 === null) ||
    !record(value.encryption) ||
    !exactKeys(value.encryption, ENCRYPTION_KEYS) ||
    (value.encryption.mode !== "none" && value.encryption.mode !== "age") ||
    !(
      value.encryption.key_fingerprint === null ||
      (typeof value.encryption.key_fingerprint === "string" &&
        /^sha256:[a-f0-9]{64}$/.test(value.encryption.key_fingerprint))
    ) ||
    (value.encryption.mode === "none" &&
      value.encryption.key_fingerprint !== null) ||
    (value.encryption.mode === "age" &&
      value.encryption.key_fingerprint === null) ||
    !record(value.provenance) ||
    !exactKeys(value.provenance, PROVENANCE_KEYS) ||
    typeof value.provenance.source_commit !== "string" ||
    !value.provenance.source_commit ||
    typeof value.provenance.workflow_run_id !== "string" ||
    !value.provenance.workflow_run_id ||
    typeof value.provenance.action_version !== "string" ||
    !value.provenance.action_version ||
    typeof value.provenance.created_at !== "string" ||
    !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(
      value.provenance.created_at,
    ) ||
    Number.isNaN(Date.parse(value.provenance.created_at)) ||
    new Date(value.provenance.created_at).toISOString() !==
      value.provenance.created_at
  ) {
    failWithCode(
      "TRS_MANIFEST_INVALID",
      "State manifest has invalid, missing, reordered, or unsupported fields.",
    );
  }
  return value as StateManifest;
}

export function serializeManifest(manifest: StateManifest): Buffer {
  const validated = validateManifest(manifest);
  return Buffer.from(
    `${JSON.stringify(canonicalManifest(validated), null, 2)}\n`,
    "utf8",
  );
}

export function parseManifest(data: Buffer): StateManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    failWithCode(
      "TRS_MANIFEST_INVALID",
      "State manifest is not valid UTF-8 JSON.",
    );
  }
  const manifest = validateManifest(parsed);
  if (!data.equals(serializeManifest(manifest))) {
    failWithCode(
      "TRS_MANIFEST_INVALID",
      "State manifest is not in canonical form.",
    );
  }
  return manifest;
}

export function terraformMetadata(
  plaintext: Buffer,
): StateManifest["terraform"] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(plaintext.toString("utf8"));
  } catch {
    return { version: null, serial: null, lineage: null };
  }
  if (!record(parsed)) return { version: null, serial: null, lineage: null };
  return {
    version:
      typeof parsed.terraform_version === "string" &&
      parsed.terraform_version.length > 0
        ? parsed.terraform_version
        : null,
    serial:
      typeof parsed.serial === "number" &&
      Number.isSafeInteger(parsed.serial) &&
      parsed.serial >= 0
        ? parsed.serial
        : null,
    lineage:
      typeof parsed.lineage === "string" && parsed.lineage.length > 0
        ? parsed.lineage
        : null,
  };
}

export function createManifest(input: ManifestInput): StateManifest {
  return {
    manifest: "terraform-release-state",
    schema_version: 1,
    object: { role: input.role, name: input.name },
    content: {
      stored: {
        sha256: sha256(input.stored),
        size_bytes: input.stored.length,
      },
      plaintext: {
        sha256: sha256(input.plaintext),
        size_bytes: input.plaintext.length,
      },
    },
    terraform: terraformMetadata(input.plaintext),
    parent: {
      remote_state_marker: input.parentMarker,
      stored_sha256: input.parentStoredSha256,
    },
    encryption: {
      mode: input.encryptionMode,
      key_fingerprint: input.encryptionKeyFingerprint,
    },
    provenance: {
      source_commit: input.sourceCommit || "unknown",
      workflow_run_id: input.workflowRunId || "unknown",
      action_version: input.actionVersion || "unknown",
      created_at: input.createdAt || new Date().toISOString(),
    },
  };
}
