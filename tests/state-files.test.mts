import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript runner resolves this source path directly.
import { writeStateFile } from "../src/state-files.mts";

test("writeStateFile creates secure parent directories and writes mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "terraform-release-state-"));
  const path = join(root, "nested", "state", "terraform.tfstate");
  writeStateFile(path, Buffer.from("state"));
  assert.equal(readFileSync(path, "utf8"), "state");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "nested", "state")).mode & 0o777, 0o700);
});
