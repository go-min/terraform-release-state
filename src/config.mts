import { resolve } from "node:path";
import { core, fail } from "./action-core.mjs";
import {
  parseBoolean,
  parseRepository,
  parseRetention,
  resolveStatePath,
  validateReleaseComponent,
} from "./validation.mjs";
import type { ActionConfig } from "./types.mjs";

export function readConfig(): ActionConfig {
  const token = core.getInput("github-token", { required: true });
  core.setSecret(token);

  const operation = core
    .getInput("operation", { required: true })
    .toLowerCase();
  if (
    operation !== "restore" &&
    operation !== "save" &&
    operation !== "reset"
  ) {
    fail("operation must be restore, save, or reset.");
  }

  const target = parseRepository(
    core.getInput("state-repository") || process.env.GITHUB_REPOSITORY || "",
  );
  const tag = core.getInput("release-tag");
  const assetName = core.getInput("state-asset");
  validateReleaseComponent(tag, "release-tag");
  validateReleaseComponent(assetName, "state-asset");

  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const statePathInput = core.getInput("state-path");
  if (operation !== "reset" && !statePathInput) {
    fail("state-path is required for restore and save.");
  }
  return {
    operation,
    token,
    target,
    tag,
    assetName,
    workspace,
    statePath: resolveStatePath(statePathInput || ".", workspace),
    bootstrap: parseBoolean(core.getInput("bootstrap"), "bootstrap"),
    expectedMarker: core.getInput("expected-remote-state-marker"),
    backupRetention: parseRetention(core.getInput("backup-retention")),
    sourceCommit: core.getInput("source-commit"),
    workflowRunId: core.getInput("workflow-run-id"),
    resetConfirmation: core.getInput("confirmation"),
  };
}
