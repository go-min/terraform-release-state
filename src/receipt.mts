import { randomUUID } from "node:crypto";
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { failWithCode } from "./errors.mjs";
import type { ActionConfig, DecodedMarker } from "./types.mjs";
import { decodeMarker } from "./marker.mjs";

type RestoreReceipt = {
  version: 1;
  repository: string;
  release_tag: string;
  state_asset: string;
  marker: string;
};

export function restoreReceiptPath(
  runnerTemp: string,
  owner: string,
  repo: string,
): string {
  return join(
    runnerTemp,
    "terraform-release-state",
    `${owner}-${repo}-restore-receipt.json`,
  );
}

function receipt(config: ActionConfig, marker: string): RestoreReceipt {
  return {
    version: 1,
    repository: `${config.target.owner}/${config.target.repo}`,
    release_tag: config.tag,
    state_asset: config.assetName,
    marker,
  };
}

export function writeRestoreReceipt(
  config: ActionConfig,
  marker: string,
): void {
  decodeMarker(marker);
  const directory = dirname(config.receiptPath);
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const temporary = `${config.receiptPath}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, `${JSON.stringify(receipt(config, marker))}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
    renameSync(temporary, config.receiptPath);
    chmodSync(config.receiptPath, 0o600);
  } catch {
    rmSync(temporary, { force: true });
    failWithCode(
      "TRS_RESTORE_RECEIPT_INVALID",
      `Unable to write the protected restore receipt at ${config.receiptPath}. Run restore again before save.`,
    );
  }
}

export function readRestoreReceipt(config: ActionConfig): DecodedMarker {
  let data: Buffer;
  try {
    const status = lstatSync(config.receiptPath);
    if (!status.isFile() || status.isSymbolicLink()) throw new Error("unsafe");
    data = readFileSync(config.receiptPath);
  } catch {
    failWithCode(
      "TRS_RESTORE_RECEIPT_REQUIRED",
      "save requires a protected receipt from a successful restore in the same job; run restore before save.",
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(data));
  } catch {
    failWithCode(
      "TRS_RESTORE_RECEIPT_INVALID",
      "The protected restore receipt is not valid UTF-8 JSON; run restore again before save.",
    );
  }
  const expected = receipt(config, "absent");
  if (
    typeof parsed !== "object" ||
    parsed === null ||
    Array.isArray(parsed) ||
    Object.keys(parsed).length !== 5 ||
    (parsed as RestoreReceipt).version !== expected.version ||
    (parsed as RestoreReceipt).repository !== expected.repository ||
    (parsed as RestoreReceipt).release_tag !== expected.release_tag ||
    (parsed as RestoreReceipt).state_asset !== expected.state_asset ||
    typeof (parsed as RestoreReceipt).marker !== "string"
  ) {
    failWithCode(
      "TRS_RESTORE_RECEIPT_INVALID",
      "The protected restore receipt does not match this repository state protocol; run restore again before save.",
    );
  }
  return decodeMarker((parsed as RestoreReceipt).marker);
}
