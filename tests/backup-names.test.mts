import { strict as assert } from "node:assert";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript runner resolves this source path directly.
import { backupName } from "../src/backup-names.mts";

test("backup names remain unique for repeated saves in one run", () => {
  const first = backupName("terraform.tfstate", "123");
  const second = backupName("terraform.tfstate", "123");
  assert.notEqual(first, second);
  assert.match(
    first,
    /^terraform\.tfstate\.backup-[0-9]{8}T[0-9]{9}Z-123-[0-9a-f-]{36}$/,
  );
});
