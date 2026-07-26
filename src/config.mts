import { dirname, resolve } from "node:path";
import { core, fail } from "./action-core.mjs";
import {
  parseBoolean,
  parseRepository,
  parseRetention,
  resolveStatePath,
  resolveImportsPath,
  validateReleaseComponent,
} from "./validation.mjs";
import { readEncryptionConfig } from "./encryption.mjs";
import type { ActionConfig } from "./types.mjs";

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
    fail("operation must be restore, save, reset, or import.");
  }

  const target = parseRepository(
    core.getInput("state-repository") || process.env.GITHUB_REPOSITORY || "",
  );
  const tag = core.getInput("release-tag");
  const assetName = core.getInput("state-asset");
  validateReleaseComponent(tag, "release-tag");
  validateReleaseComponent(assetName, "state-asset");

  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const ageIdentities = core.getInput("age-identities");
  if (ageIdentities) core.setSecret(ageIdentities);
  const encryption = readEncryptionConfig(
    core.getInput("encryption").toLowerCase(),
    core.getInput("age-recipients"),
    ageIdentities,
  );
  if (operation === "reset" && encryption.mode !== "none") {
    fail("reset does not accept encryption inputs.");
  }
  const statePathInput = core.getInput("state-path");
  if (operation !== "reset" && operation !== "import" && !statePathInput) {
    fail("state-path is required for restore and save.");
  }
  const importsPath = core.getInput("imports-path") || ".";
  const importsFile = core.getInput("imports-file") || "imports.tf";
  const importsOutput = resolveImportsPath(importsPath, importsFile, workspace);
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
    importsPath: dirname(importsOutput.path),
    importsFile: importsOutput.file,
    encryption,
  };
}
