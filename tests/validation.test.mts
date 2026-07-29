import { strict as assert } from "node:assert";
import { test } from "node:test";

const { isPathInside, parseBoolean, resolveWorkspacePath } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/validation.mjs"
);

test("validates the bootstrap environment and fixed workspace paths", async (t) => {
  await t.test("accepts only exact bootstrap booleans", () => {
    assert.equal(parseBoolean("true", "TERRAFORM_BOOTSTRAP"), true);
    assert.equal(parseBoolean("", "TERRAFORM_BOOTSTRAP"), false);
    assert.throws(
      () => parseBoolean("yes", "TERRAFORM_BOOTSTRAP"),
      /must be true or false/,
    );
  });

  await t.test("keeps fixed paths inside the workspace", () => {
    assert.equal(
      resolveWorkspacePath(
        "terraform.tfstate",
        "fixed state path",
        "/workspace",
      ),
      "/workspace/terraform.tfstate",
    );
    assert.equal(isPathInside("/workspace", "/workspace/terraform"), true);
    assert.equal(isPathInside("/workspace", "/outside/terraform"), false);
    assert.throws(
      () => resolveWorkspacePath("../state", "fixed path", "/workspace"),
      /inside GITHUB_WORKSPACE/,
    );
  });
});
