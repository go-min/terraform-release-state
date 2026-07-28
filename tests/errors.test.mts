import { strict as assert } from "node:assert";
import { test } from "node:test";

const { ActionError, displayError, failWithCode, normalizeActionError } =
  await import(
    // @ts-expect-error This source module is compiled into the temporary native-test build.
    "../.test-build/src/errors.mjs"
  );

test("stable ActionError codes survive normalization and display", () => {
  assert.throws(
    () => failWithCode("TRS_SIGNATURE_INVALID", "bad signature"),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.ok(error instanceof ActionError);
      assert.equal(
        (error as Error & { code: string }).code,
        "TRS_SIGNATURE_INVALID",
      );
      assert.equal(
        displayError(error as never),
        "[TRS_SIGNATURE_INVALID] bad signature",
      );
      assert.equal(normalizeActionError(error), error);
      return true;
    },
  );
  assert.equal(
    normalizeActionError(Object.assign(new Error("forbidden"), { status: 403 }))
      .code,
    "TRS_API_FAILURE",
  );
  assert.equal(
    normalizeActionError(new Error("unexpected")).code,
    "TRS_UNEXPECTED",
  );
});
