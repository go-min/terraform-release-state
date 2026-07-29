import * as github from "@actions/github";
import { resolve } from "node:path";
import { core, fail } from "./action-core.mjs";
import {
  BACKUP_RETENTION,
  IMPORT_PR_BASE,
  IMPORT_PR_BRANCH,
  IMPORT_PR_TITLE,
  IMPORTS_PATH,
  STATE_ASSET_NAME,
  STATE_PATH,
  STATE_RELEASE_TAG,
  TERRAFORM_ROOT,
} from "./protocol.mjs";
import { restoreReceiptPath } from "./receipt.mjs";
import type { ActionConfig } from "./types.mjs";
import { parseBoolean, resolveWorkspacePath } from "./validation.mjs";

export function readConfig(): ActionConfig {
  const operation = core
    .getInput("operation", { required: true })
    .toLowerCase();
  const token = core.getInput("github-token", { required: true });
  core.setSecret(token);
  if (
    operation !== "restore" &&
    operation !== "save" &&
    operation !== "reset" &&
    operation !== "import"
  ) {
    fail("operation must be restore, save, import, or reset.");
  }

  const target = github.context.repo;
  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) fail("RUNNER_TEMP is required by the state protocol.");
  const resetTarget = core.getInput("reset-target") || "all";
  if (operation !== "reset" && resetTarget !== "all") {
    fail("reset-target is meaningful only for operation=reset.");
  }

  return {
    operation,
    token,
    target,
    tag: STATE_RELEASE_TAG,
    assetName: STATE_ASSET_NAME,
    workspace,
    statePath: resolveWorkspacePath(STATE_PATH, "fixed state path", workspace),
    receiptPath: restoreReceiptPath(
      resolve(runnerTemp),
      target.owner,
      target.repo,
    ),
    bootstrap: parseBoolean(
      process.env.TERRAFORM_BOOTSTRAP || "",
      "TERRAFORM_BOOTSTRAP",
    ),
    backupRetention: BACKUP_RETENTION,
    sourceCommit: github.context.sha || process.env.GITHUB_SHA || "",
    workflowRunId: process.env.GITHUB_RUN_ID || "",
    resetTarget,
    importsPath: resolveWorkspacePath(
      IMPORTS_PATH,
      "fixed imports path",
      workspace,
    ),
    terraformRoot: resolveWorkspacePath(
      TERRAFORM_ROOT,
      "fixed Terraform root",
      workspace,
    ),
    prBase: IMPORT_PR_BASE,
    prBranch: IMPORT_PR_BRANCH,
    prTitle: IMPORT_PR_TITLE,
  };
}
