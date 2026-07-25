import { strict as assert } from "node:assert";
import {
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript runner resolves this source path directly.
import { readStateFile, writeStateFile } from "../src/state-files.mts";

test("writeStateFile creates secure parent directories and writes mode 0600", () => {
  const root = mkdtempSync(join(tmpdir(), "terraform-release-state-"));
  const path = join(root, "nested", "state", "terraform.tfstate");
  writeStateFile(path, root, Buffer.from("state"));
  assert.equal(readFileSync(path, "utf8"), "state");
  assert.equal(statSync(path).mode & 0o777, 0o600);
  assert.equal(statSync(join(root, "nested", "state")).mode & 0o777, 0o700);
});

test("state files reject symbolic links that escape the workspace", () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-workspace-"),
  );
  const outside = mkdtempSync(
    join(tmpdir(), "terraform-release-state-outside-"),
  );
  try {
    symlinkSync(outside, join(workspace, "escape"), "dir");
    const path = join(workspace, "escape", "terraform.tfstate");
    assert.throws(
      () => writeStateFile(path, workspace, Buffer.from("state")),
      /symbolic links/,
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});

test("state reads reject a symbolic-link file outside the workspace", () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-workspace-"),
  );
  const outside = mkdtempSync(
    join(tmpdir(), "terraform-release-state-outside-"),
  );
  try {
    const outsideState = join(outside, "terraform.tfstate");
    writeFileSync(outsideState, "outside state", { mode: 0o600 });
    const path = join(workspace, "terraform.tfstate");
    symlinkSync(outsideState, path, "file");
    assert.throws(() => readStateFile(path, workspace), /symbolic link/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
