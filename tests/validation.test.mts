import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseBoolean,
  parseRepository,
  parseRetention,
  resolveStatePath,
  validateGitRef,
  validateReleaseComponent,
  // @ts-expect-error Node's native TypeScript runner resolves this source path directly.
} from "../src/validation.mts";
const { validateResetConfirmation } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/reset-core.mjs"
);

test("validates action inputs", async (t) => {
  await t.test("parses booleans and retention", () => {
    assert.equal(parseBoolean("true", "bootstrap"), true);
    assert.equal(parseBoolean("", "bootstrap"), false);
    assert.equal(parseRetention("20"), 20);
    assert.throws(() => parseBoolean("yes", "bootstrap"), /must be true/);
    assert.throws(() => parseRetention("1001"), /0 through 1000/);
  });

  await t.test("validates repository and release components", () => {
    assert.deepEqual(parseRepository("go-min/state"), {
      owner: "go-min",
      repo: "state",
    });
    assert.throws(() => parseRepository("go-min/state/extra"), /owner\/name/);
    assert.doesNotThrow(() =>
      validateReleaseComponent("terraform-state", "tag"),
    );
    assert.throws(
      () => validateReleaseComponent("../state", "tag"),
      /unsupported/,
    );
  });

  await t.test("keeps state paths inside the workspace", () => {
    assert.equal(
      resolveStatePath("state/terraform.tfstate", "/workspace"),
      "/workspace/state/terraform.tfstate",
    );
    assert.equal(
      resolveStatePath("..state/terraform.tfstate", "/workspace"),
      "/workspace/..state/terraform.tfstate",
    );
    assert.throws(
      () => resolveStatePath("../terraform.tfstate", "/workspace"),
      /inside/,
    );
    assert.throws(() => resolveStatePath("", "/workspace"), /non-empty/);
  });

  await t.test("validates pull request branch refs", () => {
    assert.doesNotThrow(() =>
      validateGitRef("terraform-release-state/generated", "branch"),
    );
    assert.throws(() => validateGitRef("../main", "branch"), /unsupported/);
    assert.throws(() => validateGitRef("main:broken", "branch"), /unsupported/);
  });

  await t.test("requires explicit reset confirmation", () => {
    assert.doesNotThrow(() => validateResetConfirmation("RESET"));
    assert.throws(
      () => validateResetConfirmation("reset"),
      /confirmation=RESET/,
    );
    assert.throws(
      () => validateResetConfirmation(""),
      /no state resources were changed/,
    );
  });
});
