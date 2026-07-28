import { basename, resolve } from "node:path";
import { core, fail } from "./action-core.mjs";
import {
  parseBoolean,
  parseRepository,
  parseRetention,
  resolveStatePath,
  resolveWorkspacePath,
  validateGitRef,
  validateReleaseComponent,
} from "./validation.mjs";
import { readEncryptionConfig } from "./encryption.mjs";
import { readSigningConfig } from "./signing.mjs";
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

  const currentRepository = parseRepository(
    process.env.GITHUB_REPOSITORY || core.getInput("state-repository") || "",
  );
  const target = parseRepository(
    core.getInput("state-repository") ||
      `${currentRepository.owner}/${currentRepository.repo}`,
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
  const signingPrivateKey = core.getInput("signing-private-key");
  if (signingPrivateKey) core.setSecret(signingPrivateKey);
  const signing = readSigningConfig(
    operation,
    core.getInput("signature-policy").toLowerCase(),
    signingPrivateKey,
    core.getInput("verification-public-keys"),
  );
  if (operation === "reset" && encryption.mode !== "none") {
    fail("reset does not accept encryption inputs.");
  }
  const statePathInput = core.getInput("state-path");
  if (operation !== "reset" && operation !== "import" && !statePathInput) {
    fail("state-path is required for restore and save.");
  }
  const importsPath = resolveWorkspacePath(
    core.getInput("imports-path") || "./imports.generated.tf",
    "imports-path",
    workspace,
  );
  const terraformRoot = resolveWorkspacePath(
    core.getInput("terraform-root") || ".",
    "terraform-root",
    workspace,
  );
  const createPr = parseBoolean(core.getInput("create-pr"), "create-pr");
  const prBase = core.getInput("pr-base") || process.env.GITHUB_REF_NAME || "";
  const prBranch =
    core.getInput("pr-branch") ||
    `terraform-release-state/${basename(importsPath).replace(/[^A-Za-z0-9._-]/g, "-")}`;
  const prTitle =
    core.getInput("pr-title") || "chore(terraform): update generated imports";
  if (operation === "import" && createPr) {
    validateGitRef(prBase, "pr-base");
    validateGitRef(prBranch, "pr-branch");
    if (prBase === prBranch) {
      fail("pr-base and pr-branch must be different.");
    }
  }
  return {
    operation,
    token,
    target,
    prTarget: currentRepository,
    tag,
    assetName,
    workspace,
    statePath: resolveStatePath(statePathInput || ".", workspace),
    bootstrap: parseBoolean(core.getInput("bootstrap"), "bootstrap"),
    expectedMarker: core.getInput("expected-remote-state-marker"),
    backupRetention: parseRetention(core.getInput("backup-retention")),
    sourceCommit:
      core.getInput("source-commit") || process.env.GITHUB_SHA || "",
    workflowRunId:
      core.getInput("workflow-run-id") || process.env.GITHUB_RUN_ID || "",
    resetConfirmation: core.getInput("confirmation"),
    importsPath,
    terraformRoot,
    createPr,
    prBase,
    prBranch,
    prTitle,
    encryption,
    signing,
  };
}
