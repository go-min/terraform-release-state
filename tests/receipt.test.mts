import { strict as assert } from "node:assert";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { test } from "node:test";

const { readRestoreReceipt, restoreReceiptPath, writeRestoreReceipt } =
  await import(
    // @ts-expect-error This source module is compiled into the temporary native-test build.
    "../.test-build/src/receipt.mjs"
  );

function config(root: string) {
  return {
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    receiptPath: restoreReceiptPath(root, "go-min", "state"),
  };
}

test("restore receipt round-trips absent and opaque markers", () => {
  const root = mkdtempSync(join(tmpdir(), "trs-receipt-"));
  const actionConfig = config(root);
  const marker = Buffer.from(
    JSON.stringify({
      id: 7,
      name: "terraform.tfstate",
      digest: "sha256:abc",
      size: 12,
      updatedAt: "2026-07-29T10:00:00Z",
    }),
  ).toString("base64url");
  try {
    writeRestoreReceipt(actionConfig as never, "absent");
    assert.equal(readRestoreReceipt(actionConfig as never), "absent");
    writeRestoreReceipt(actionConfig as never, marker);
    assert.deepEqual(readRestoreReceipt(actionConfig as never), {
      id: 7,
      name: "terraform.tfstate",
      digest: "sha256:abc",
      size: 12,
      updatedAt: "2026-07-29T10:00:00Z",
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("save fails closed without a matching regular receipt", () => {
  const root = mkdtempSync(join(tmpdir(), "trs-receipt-missing-"));
  const outside = join(root, "outside.json");
  const actionConfig = config(root);
  try {
    assert.throws(
      () => readRestoreReceipt(actionConfig as never),
      /TRS_RESTORE_RECEIPT_REQUIRED|successful restore/,
    );
    mkdirSync(dirname(actionConfig.receiptPath), { recursive: true });
    symlinkSync(outside, actionConfig.receiptPath);
    assert.throws(
      () => readRestoreReceipt(actionConfig as never),
      /TRS_RESTORE_RECEIPT_REQUIRED|successful restore/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
