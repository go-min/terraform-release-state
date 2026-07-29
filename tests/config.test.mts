import { strict as assert } from "node:assert";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";

const { readConfig } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/config.mjs"
);

function withEnvironment(
  values: Record<string, string | undefined>,
  operation: () => void,
): void {
  const previous = new Map<string, string | undefined>();
  for (const [name, value] of Object.entries(values)) {
    previous.set(name, process.env[name]);
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  try {
    operation();
  } finally {
    for (const [name, value] of previous) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

test("config derives the complete zero-config protocol from GitHub context", () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-config-workspace-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "trs-config-runner-"));
  try {
    withEnvironment(
      {
        GITHUB_REPOSITORY: "go-min/terraform-release-state",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        GITHUB_SHA: "source-sha",
        GITHUB_RUN_ID: "run-42",
        TERRAFORM_BOOTSTRAP: "true",
        INPUT_OPERATION: "import",
        INPUT_GITHUB_TOKEN: "token",
        INPUT_RESET_TARGET: undefined,
      },
      () => {
        const config = readConfig();
        assert.deepEqual(config.target, {
          owner: "go-min",
          repo: "terraform-release-state",
        });
        assert.equal(config.tag, "terraform-state");
        assert.equal(config.assetName, "terraform.tfstate");
        assert.equal(config.statePath, join(workspace, "terraform.tfstate"));
        assert.equal(config.backupRetention, 20);
        assert.equal(config.bootstrap, true);
        assert.equal(
          config.importsPath,
          join(workspace, "imports.generated.tf"),
        );
        assert.equal(config.terraformRoot, workspace);
        assert.equal(config.prBase, "main");
        assert.equal(
          config.prBranch,
          "terraform-release-state/imports.generated.tf",
        );
        assert.match(config.receiptPath, /restore-receipt\.json$/);
      },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("config defaults reset-target to all and rejects it for other operations", () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-config-reset-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "trs-config-runner-"));
  const common = {
    GITHUB_REPOSITORY: "go-min/state",
    GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: runnerTemp,
    INPUT_GITHUB_TOKEN: "token",
    TERRAFORM_BOOTSTRAP: undefined,
  };
  try {
    withEnvironment(
      {
        ...common,
        INPUT_OPERATION: "reset",
        INPUT_RESET_TARGET: undefined,
      },
      () => assert.equal(readConfig().resetTarget, "all"),
    );
    withEnvironment(
      {
        ...common,
        INPUT_OPERATION: "restore",
        INPUT_RESET_TARGET: "terraform.tfstate.backup-example",
      },
      () =>
        assert.throws(
          readConfig,
          /reset-target is meaningful only for operation=reset/,
        ),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("bootstrap input is canonical and the environment is a strict fallback", () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-config-bootstrap-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "trs-config-runner-"));
  try {
    withEnvironment(
      {
        GITHUB_REPOSITORY: "go-min/state",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        INPUT_OPERATION: "restore",
        INPUT_GITHUB_TOKEN: "token",
        INPUT_RESET_TARGET: undefined,
        INPUT_BOOTSTRAP: "true",
        TERRAFORM_BOOTSTRAP: "TRUE",
      },
      () => assert.equal(readConfig().bootstrap, true),
    );
    withEnvironment(
      {
        GITHUB_REPOSITORY: "go-min/state",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        INPUT_OPERATION: "restore",
        INPUT_GITHUB_TOKEN: "token",
        INPUT_BOOTSTRAP: "false",
        TERRAFORM_BOOTSTRAP: "true",
      },
      () => assert.equal(readConfig().bootstrap, false),
    );
    withEnvironment(
      {
        GITHUB_REPOSITORY: "go-min/state",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        INPUT_OPERATION: "restore",
        INPUT_GITHUB_TOKEN: "token",
        INPUT_BOOTSTRAP: undefined,
        TERRAFORM_BOOTSTRAP: "TRUE",
      },
      () =>
        assert.throws(readConfig, /TERRAFORM_BOOTSTRAP must be true or false/),
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});

test("config accepts explicit storage, crypto, and import overrides", () => {
  const workspace = mkdtempSync(join(tmpdir(), "trs-config-overrides-"));
  const runnerTemp = mkdtempSync(join(tmpdir(), "trs-config-runner-"));
  try {
    withEnvironment(
      {
        GITHUB_REPOSITORY: "go-min/workflow",
        GITHUB_WORKSPACE: workspace,
        RUNNER_TEMP: runnerTemp,
        INPUT_OPERATION: "import",
        INPUT_GITHUB_TOKEN: "token",
        INPUT_STATE_REPOSITORY: "go-min/state-storage",
        INPUT_RELEASE_TAG: "team-state",
        INPUT_STATE_ASSET: "network.tfstate",
        INPUT_STATE_PATH: "state/network.tfstate",
        INPUT_BACKUP_RETENTION: "7",
        INPUT_TERRAFORM_ROOT: "terraform",
        INPUT_IMPORTS_PATH: "terraform/imports.generated.tf",
        INPUT_CREATE_PR: "false",
        INPUT_ENCRYPTION: "none",
        INPUT_SIGNATURE_POLICY: "allow-unsigned",
      },
      () => {
        const config = readConfig();
        assert.deepEqual(config.target, {
          owner: "go-min",
          repo: "state-storage",
        });
        assert.equal(config.tag, "team-state");
        assert.equal(config.assetName, "network.tfstate");
        assert.equal(
          config.statePath,
          join(workspace, "state/network.tfstate"),
        );
        assert.equal(config.backupRetention, 7);
        assert.equal(config.createPr, false);
        assert.equal(config.terraformRoot, join(workspace, "terraform"));
      },
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(runnerTemp, { recursive: true, force: true });
  }
});
