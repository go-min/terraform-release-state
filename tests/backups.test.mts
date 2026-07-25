import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript runner resolves this source path directly.
import { isBackupAsset, metadataAssetNames } from "../src/backups.mts";

test("backup retention distinguishes state assets from metadata", () => {
  assert.equal(isBackupAsset("terraform.tfstate.backup-20260725T120000Z", "terraform.tfstate"), true);
  assert.equal(isBackupAsset("terraform.tfstate.backup-20260725T120000Z.metadata.json", "terraform.tfstate"), false);
  assert.equal(isBackupAsset("other.tfstate.backup-20260725T120000Z", "terraform.tfstate"), false);
});

test("backup cleanup recognizes metadata format", () => {
  assert.deepEqual(metadataAssetNames("terraform.tfstate.backup-20260725T120000Z"), [
    "terraform.tfstate.backup-20260725T120000Z.metadata.json",
  ]);
});
