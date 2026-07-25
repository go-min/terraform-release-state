import { strict as assert } from "node:assert";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
// @ts-expect-error Node's native TypeScript runner resolves this source path directly.
import { core } from "../src/action-core.mts";

test("outputs use the environment file and reject deprecated workflow syntax", () => {
  const directory = mkdtempSync(join(tmpdir(), "terraform-release-output-"));
  const outputFile = join(directory, "output");
  const previousOutput = process.env.GITHUB_OUTPUT;
  const previousActions = process.env.GITHUB_ACTIONS;
  try {
    process.env.GITHUB_OUTPUT = outputFile;
    process.env.GITHUB_ACTIONS = "true";
    core.setOutput("result", "safe");
    assert.equal(readFileSync(outputFile, "utf8"), "result=safe\n");

    delete process.env.GITHUB_OUTPUT;
    assert.throws(() => core.setOutput("result", "safe"), /GITHUB_OUTPUT/);
  } finally {
    if (previousOutput === undefined) delete process.env.GITHUB_OUTPUT;
    else process.env.GITHUB_OUTPUT = previousOutput;
    if (previousActions === undefined) delete process.env.GITHUB_ACTIONS;
    else process.env.GITHUB_ACTIONS = previousActions;
    rmSync(directory, { recursive: true, force: true });
  }
});

test("multiline secrets are masked one line at a time", (context) => {
  const writes: string[] = [];
  context.mock.method(
    process.stdout,
    "write",
    (chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    },
  );

  core.setSecret("first%secret\n  second-secret  ");
  assert.deepEqual(writes, [
    "::add-mask::first%25secret\n",
    "::add-mask::second-secret\n",
  ]);
});

test("failure messages cannot inject workflow commands", (context) => {
  const writes: string[] = [];
  const previousExitCode = process.exitCode;
  context.mock.method(
    process.stderr,
    "write",
    (chunk: string | Uint8Array): boolean => {
      writes.push(String(chunk));
      return true;
    },
  );

  try {
    core.setFailed("failed%value\n::warning::injected");
    assert.deepEqual(writes, [
      "::error::failed%25value%0A::warning::injected\n",
    ]);
    assert.equal(process.exitCode, 1);
  } finally {
    process.exitCode = previousExitCode;
  }
});
