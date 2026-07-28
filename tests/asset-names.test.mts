import { strict as assert } from "node:assert";
import { test } from "node:test";
const {
  backupNameFromMetadata,
  backupObjectName,
  bundleAssets,
  bundleNames,
  createBackupName,
  isBackupAsset,
  manifestName,
  metadataName,
  signatureName,
} = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/asset-names.mjs"
);

test("asset names keep current state, backups, and metadata distinct", () => {
  assert.equal(
    metadataName("terraform.tfstate"),
    "terraform.tfstate.metadata.json",
  );
  assert.equal(
    manifestName("terraform.tfstate"),
    "terraform.tfstate.manifest.json",
  );
  assert.equal(
    signatureName("terraform.tfstate"),
    "terraform.tfstate.manifest.sig.json",
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

test("bundle classifier keeps state objects separate from companions", () => {
  const names = bundleNames("terraform.tfstate.backup-a");
  assert.deepEqual(names, {
    state: "terraform.tfstate.backup-a",
    metadata: "terraform.tfstate.backup-a.metadata.json",
    manifest: "terraform.tfstate.backup-a.manifest.json",
    signature: "terraform.tfstate.backup-a.manifest.sig.json",
  });
  assert.equal(
    backupObjectName(names.signature, "terraform.tfstate"),
    "terraform.tfstate.backup-a",
  );
  const assets = Object.values(names).map((name, index) => ({
    id: index + 1,
    name,
    state: "uploaded",
  }));
  const bundle = bundleAssets(assets as never, "terraform.tfstate.backup-a");
  assert.equal(bundle.state?.name, names.state);
  assert.equal(bundle.metadata?.name, names.metadata);
  assert.equal(bundle.manifest?.name, names.manifest);
  assert.equal(bundle.signature?.name, names.signature);
  assert.equal(isBackupAsset(names.manifest, "terraform.tfstate"), false);
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
