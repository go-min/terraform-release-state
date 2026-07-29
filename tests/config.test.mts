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
          join(workspace, "terraform/imports.generated.tf"),
        );
        assert.equal(config.terraformRoot, join(workspace, "terraform"));
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

test("bootstrap accepts only the exact environment boundary", () => {
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
