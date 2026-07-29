import * as github from "@actions/github";
import { basename, resolve } from "node:path";
import { core, fail } from "./action-core.mjs";
import { readEncryptionConfig } from "./encryption.mjs";
import {
  BACKUP_RETENTION,
  IMPORTS_PATH,
  STATE_ASSET_NAME,
  STATE_PATH,
  STATE_RELEASE_TAG,
  TERRAFORM_ROOT,
} from "./protocol.mjs";
import { restoreReceiptPath } from "./receipt.mjs";
import { readSigningConfig } from "./signing.mjs";
import type { ActionConfig } from "./types.mjs";
import {
  parseBoolean,
  parseRepository,
  parseRetention,
  resolveWorkspacePath,
  validateGitRef,
  validateReleaseComponent,
} from "./validation.mjs";

function bootstrapInput(): boolean {
  const input = core.getInput("bootstrap");
  if (input) return parseBoolean(input, "bootstrap");
  const legacy = process.env.TERRAFORM_BOOTSTRAP || "";
  if (legacy) {
    core.warning(
      "TERRAFORM_BOOTSTRAP is deprecated; use the bootstrap action input.",
    );
  }
  return parseBoolean(legacy, "TERRAFORM_BOOTSTRAP");
}

function defaultBranch(): string {
  const repository = github.context.payload.repository as
    | { default_branch?: unknown }
    | undefined;
  return typeof repository?.default_branch === "string" &&
    repository.default_branch
    ? repository.default_branch
    : process.env.GITHUB_REF_NAME || "main";
}

export function readConfig(): ActionConfig {
  const operation = core
    .getInput("operation", { required: true })
    .toLowerCase();
  const token = core.getInput("github-token", { required: true });
  core.setSecret(token);
  if (!["restore", "save", "reset", "import"].includes(operation)) {
    fail("operation must be restore, save, import, or reset.");
  }

  const currentRepository = github.context.repo;
  const target = parseRepository(
    core.getInput("state-repository") ||
      `${currentRepository.owner}/${currentRepository.repo}`,
  );
  const tag = core.getInput("release-tag") || STATE_RELEASE_TAG;
  const assetName = core.getInput("state-asset") || STATE_ASSET_NAME;
  validateReleaseComponent(tag, "release-tag");
  validateReleaseComponent(assetName, "state-asset");

  const workspace = resolve(process.env.GITHUB_WORKSPACE || process.cwd());
  const runnerTemp = process.env.RUNNER_TEMP;
  if (!runnerTemp) fail("RUNNER_TEMP is required by the state protocol.");
  const ageIdentities = core.getInput("age-identities");
  if (ageIdentities) core.setSecret(ageIdentities);
  const signingPrivateKey = core.getInput("signing-private-key");
  if (signingPrivateKey) core.setSecret(signingPrivateKey);
  const encryption = readEncryptionConfig(
    core.getInput("encryption").toLowerCase(),
    core.getInput("age-recipients"),
    ageIdentities,
  );
  const signing = readSigningConfig(
    operation as ActionConfig["operation"],
    core.getInput("signature-policy").toLowerCase(),
    signingPrivateKey,
    core.getInput("verification-public-keys"),
  );
  const resetTarget = core.getInput("reset-target") || "all";
  if (operation !== "reset" && resetTarget !== "all") {
    fail("reset-target is meaningful only for operation=reset.");
  }
  const importsPath = resolveWorkspacePath(
    core.getInput("imports-path") || IMPORTS_PATH,
    "imports-path",
    workspace,
  );
  const terraformRoot = resolveWorkspacePath(
    core.getInput("terraform-root") || TERRAFORM_ROOT,
    "terraform-root",
    workspace,
  );
  const createPr = parseBoolean(
    core.getInput("create-pr") || "true",
    "create-pr",
  );
  const prBase = core.getInput("pr-base") || defaultBranch();
  const prBranch = `terraform-release-state/${basename(importsPath).replace(/[^A-Za-z0-9._-]/g, "-")}`;
  if (operation === "import" && createPr) validateGitRef(prBase, "pr-base");

  return {
    operation: operation as ActionConfig["operation"],
    token,
    target,
    prTarget: currentRepository,
    tag,
    assetName,
    workspace,
    statePath: resolveWorkspacePath(
      core.getInput("state-path") || STATE_PATH,
      "state-path",
      workspace,
    ),
    receiptPath: restoreReceiptPath(
      resolve(runnerTemp),
      target.owner,
      target.repo,
      tag,
      assetName,
    ),
    bootstrap: bootstrapInput(),
    backupRetention: parseRetention(
      core.getInput("backup-retention") || String(BACKUP_RETENTION),
    ),
    sourceCommit: github.context.sha || process.env.GITHUB_SHA || "",
    workflowRunId: process.env.GITHUB_RUN_ID || "",
    resetTarget,
    importsPath,
    terraformRoot,
    createPr,
    prBase,
    prBranch,
    prTitle: "chore(terraform): update generated imports",
    encryption,
    signing,
  };
}
