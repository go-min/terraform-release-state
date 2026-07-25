import { strict as assert } from "node:assert";
import { test } from "node:test";
const { createStateMetadata, parseStateMetadata } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/state-metadata.mjs"
);
const { currentMetadataName } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/backups.mjs"
);

test("encrypted state metadata is versioned and bound to ciphertext", () => {
  const ciphertext = Buffer.from("ciphertext");
  const metadata = createStateMetadata(ciphertext);
  assert.equal(
    currentMetadataName("terraform.tfstate"),
    "terraform.tfstate.metadata.json",
  );
  assert.equal(
    parseStateMetadata(metadata, "age", ciphertext)?.encryption,
    "age",
  );
  assert.throws(
    () => parseStateMetadata(metadata, "age", Buffer.from("tampered")),
    /checksum/,
  );
  assert.throws(
    () => parseStateMetadata(metadata, "none", ciphertext),
    /requires encryption/,
  );
});
