import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  parseBoolean,
  parseRepository,
  parseRetention,
  resolveStatePath,
  validateReleaseComponent,
  // @ts-expect-error Node's native TypeScript runner resolves this source path directly.
} from "../src/validation.mts";

test("validates action inputs", async (t) => {
  await t.test("parses booleans and retention", () => {
    assert.equal(parseBoolean("true", "bootstrap"), true);
    assert.equal(parseBoolean("", "bootstrap"), false);
    assert.equal(parseRetention("20"), 20);
    assert.throws(() => parseBoolean("yes", "bootstrap"), /must be true/);
    assert.throws(() => parseRetention("1001"), /0 through 1000/);
  });

  await t.test("validates repository and release components", () => {
    assert.deepEqual(parseRepository("ter-sh/state"), {
      owner: "ter-sh",
      repo: "state",
    });
    assert.throws(() => parseRepository("ter-sh/state/extra"), /owner\/name/);
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
    assert.throws(
      () => resolveStatePath("../terraform.tfstate", "/workspace"),
      /inside/,
    );
    assert.throws(() => resolveStatePath("", "/workspace"), /non-empty/);
  });
});
