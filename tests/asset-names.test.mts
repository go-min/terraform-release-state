import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  backupNameFromMetadata,
  createBackupName,
  isBackupAsset,
  metadataName,
  // @ts-expect-error Node's native TypeScript runner resolves this source path directly.
} from "../src/asset-names.mts";

test("asset names keep current state, backups, and metadata distinct", () => {
  assert.equal(
    metadataName("terraform.tfstate"),
    "terraform.tfstate.metadata.json",
  );
  assert.equal(
    metadataName("terraform.tfstate.backup-20260725T120000Z"),
    "terraform.tfstate.backup-20260725T120000Z.metadata.json",
  );
  assert.equal(
    isBackupAsset(
      "terraform.tfstate.backup-20260725T120000Z",
      "terraform.tfstate",
    ),
    true,
  );
  assert.equal(
    isBackupAsset(
      "terraform.tfstate.backup-20260725T120000Z.metadata.json",
      "terraform.tfstate",
    ),
    false,
  );
  assert.equal(
    isBackupAsset("other.tfstate.backup-1", "terraform.tfstate"),
    false,
  );
  assert.equal(
    backupNameFromMetadata(
      "terraform.tfstate.backup-1.metadata.json",
      "terraform.tfstate",
    ),
    "terraform.tfstate.backup-1",
  );
  assert.equal(
    backupNameFromMetadata(
      "terraform.tfstate.metadata.json",
      "terraform.tfstate",
    ),
    undefined,
  );
});

test("backup names remain unique for repeated saves in one run", () => {
  const first = createBackupName("terraform.tfstate", "123");
  const second = createBackupName("terraform.tfstate", "123");
  assert.notEqual(first, second);
  assert.match(
    first,
    /^terraform\.tfstate\.backup-[0-9]{8}T[0-9]{9}Z-123-[0-9a-f-]{36}$/,
  );
});
