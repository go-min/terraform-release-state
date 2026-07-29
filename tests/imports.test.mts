import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const testModulePath: string = "../.test-build/src/imports.mjs";
const {
  candidatesFromState,
  generateImports,
  localImportsDiffBase,
  renderImports,
} = await import(testModulePath);

test("StateImport creates deterministic candidates for managed instances", () => {
  const result = candidatesFromState({
    resources: [
      {
        mode: "managed",
        type: "aws_instance",
        name: "web",
        instances: [{ attributes: { id: "i-web" } }],
      },
      {
        mode: "managed",
        type: "aws_iam_user",
        name: "users",
        instances: [
          { index_key: "alice", attributes: { id: "alice" } },
          { index_key: "bob", attributes: { id: "bob" } },
        ],
      },
      {
        mode: "managed",
        module: "module.network",
        type: "aws_vpc",
        name: "main",
        instances: [{ index_key: 0, attributes: { id: "vpc-main" } }],
      },
    ],
  });

  assert.deepEqual(result.candidates, [
    { address: 'aws_iam_user.users["alice"]', id: "alice" },
    { address: 'aws_iam_user.users["bob"]', id: "bob" },
    { address: "aws_instance.web", id: "i-web" },
    { address: "module.network.aws_vpc.main[0]", id: "vpc-main" },
  ]);
  assert.deepEqual(result.skipped, []);
});

test("StateImport skips data resources and instances without IDs", () => {
  const result = candidatesFromState({
    resources: [
      {
        mode: "data",
        type: "aws_caller_identity",
        name: "current",
        instances: [{ attributes: { id: "123" } }],
      },
      {
        mode: "managed",
        type: "aws_s3_bucket",
        name: "missing",
        instances: [{ attributes: { arn: "arn:example" } }],
      },
    ],
  });

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.skipped, [
    {
      address: "aws_caller_identity.current",
      reason: "not a managed resource",
    },
    {
      address: "aws_s3_bucket.missing",
      reason: "missing string or numeric attributes.id",
    },
  ]);
});

test("StateImport normalizes GitHub provider-specific import IDs", () => {
  const result = candidatesFromState({
    resources: [
      {
        mode: "managed",
        type: "github_repository_ruleset",
        name: "default",
        instances: [
          {
            attributes: {
              id: 12345,
              repository: "terraform-release-state",
              enforcement: "active",
            },
          },
        ],
      },
      {
        mode: "managed",
        type: "github_repository_vulnerability_alerts",
        name: "default",
        instances: [
          {
            attributes: {
              id: 67890,
              repository: "terraform-release-state",
              enabled: true,
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.candidates, [
    {
      address: "github_repository_ruleset.default",
      id: "terraform-release-state:12345",
    },
    {
      address: "github_repository_vulnerability_alerts.default",
      id: "terraform-release-state",
    },
  ]);
  assert.deepEqual(result.skipped, []);
  const output = renderImports(result.candidates);
  assert.doesNotMatch(output, /enforcement|enabled/);
});

test("StateImport preserves generic and already-normalized IDs", () => {
  const result = candidatesFromState({
    resources: [
      {
        mode: "managed",
        type: "github_repository",
        name: "main",
        instances: [{ attributes: { id: "terraform-release-state" } }],
      },
      {
        mode: "managed",
        type: "github_branch",
        name: "main",
        instances: [{ attributes: { id: "terraform-release-state:main" } }],
      },
      {
        mode: "managed",
        type: "github_repository_ruleset",
        name: "existing",
        instances: [
          {
            attributes: {
              id: "terraform-release-state:12345",
              repository: "terraform-release-state",
            },
          },
        ],
      },
    ],
  });

  assert.deepEqual(result.candidates, [
    {
      address: "github_branch.main",
      id: "terraform-release-state:main",
    },
    {
      address: "github_repository_ruleset.existing",
      id: "terraform-release-state:12345",
    },
    {
      address: "github_repository.main",
      id: "terraform-release-state",
    },
  ]);
  assert.deepEqual(result.skipped, []);
});

test("StateImport skips provider-specific resources without repository", () => {
  const result = candidatesFromState({
    resources: [
      {
        mode: "managed",
        type: "github_repository_ruleset",
        name: "missing_repository",
        instances: [{ attributes: { id: 12345 } }],
      },
      {
        mode: "managed",
        type: "github_repository_vulnerability_alerts",
        name: "missing_repository",
        instances: [{ attributes: { id: 67890, enabled: true } }],
      },
    ],
  });

  assert.deepEqual(result.candidates, []);
  assert.deepEqual(result.skipped, [
    {
      address: "github_repository_ruleset.missing_repository",
      reason:
        "missing non-empty attributes.repository required for github_repository_ruleset import ID",
    },
    {
      address: "github_repository_vulnerability_alerts.missing_repository",
      reason:
        "missing non-empty attributes.repository required for github_repository_vulnerability_alerts import ID",
    },
  ]);
});

test("StateImport renders stable HCL without exposing other state attributes", () => {
  const output = renderImports([{ address: "aws_instance.web", id: "i-web" }]);

  assert.equal(
    output,
    `# This file was generated from Terraform state stored in GitHub Release assets.\n# Review every import target and the resulting Terraform plan before applying.\n# Provider-specific import IDs are copied from Terraform state.\n\nimport {\n  to = aws_instance.web\n  id = "i-web"\n}\n`,
  );
  assert.equal(output.includes("attributes"), false);
});

test("StateImport reads the Release asset and does not create a local state file", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-import-"),
  );
  const statePath = join(workspace, "terraform.tfstate");
  const terraformRoot = join(workspace, "terraform");
  const importsPath = join(terraformRoot, "imports.generated.tf");
  const outputFile = join(workspace, "outputs.txt");
  const state = Buffer.from(
    JSON.stringify({
      resources: [
        {
          mode: "managed",
          type: "aws_instance",
          name: "web",
          instances: [{ attributes: { id: "i-remote" } }],
        },
      ],
    }),
  );
  mkdirSync(terraformRoot);
  writeFileSync(importsPath, "# local file must remain untouched\n");
  const generated = renderImports([
    { address: "aws_instance.web", id: "i-remote" },
  ]);
  const asset = {
    id: 7,
    name: "terraform.tfstate",
    state: "uploaded",
    size: state.length,
  };
  const octokit = {
    paginate: async () => [asset],
    request: async () => ({ data: state }),
    rest: {
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref !== "heads/main") {
            throw Object.assign(new Error("missing"), { status: 404 });
          }
          return { data: { object: { sha: "base-sha" } } };
        },
      },
      repos: {
        getReleaseByTag: async () => ({ data: { id: 1 } }),
        listReleaseAssets: "list",
        getContent: async () => ({
          data: {
            type: "file",
            content: Buffer.from(generated).toString("base64"),
          },
        }),
      },
      pulls: { list: async () => ({ data: [] }) },
    },
  } as never;
  const config = {
    operation: "import",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath,
    bootstrap: false,
    receiptPath: join(workspace, "receipt.json"),
    backupRetention: 20,
    sourceCommit: "",
    workflowRunId: "",
    resetTarget: "all",
    importsPath,
    terraformRoot,
    prBase: "main",
    prBranch: "terraform-release-state/imports.generated.tf",
    prTitle: "chore(terraform): update generated imports",
  } as never;

  try {
    process.env.GITHUB_OUTPUT = outputFile;
    await generateImports({ octokit, config });
    assert.equal(
      readFileSync(importsPath, "utf8"),
      "# local file must remain untouched\n",
    );
    assert.equal(existsSync(statePath), false);
    const outputs = readFileSync(outputFile, "utf8");
    assert.match(outputs, /operation<<[^\n]+\nimport\n/);
    assert.match(outputs, /import-candidate-count<<[^\n]+\n1\n/);
    assert.match(outputs, /import-skipped-count<<[^\n]+\n0\n/);
    assert.match(outputs, /import-collision-count<<[^\n]+\n0\n/);
    assert.match(outputs, /import-pr-action<<[^\n]+\nunchanged\n/);
  } finally {
    delete process.env.GITHUB_OUTPUT;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("StateImport suppresses a target declared in a non-generated tf file", async () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-collision-"),
  );
  const terraformRoot = join(workspace, "terraform");
  const importsPath = join(terraformRoot, "imports.generated.tf");
  const outputFile = join(workspace, "outputs.txt");
  mkdirSync(terraformRoot);
  writeFileSync(
    join(terraformRoot, "existing.tf"),
    `import {
  to = aws_instance.web
  id = "i-existing"
}
`,
  );
  writeFileSync(importsPath, "# generated file is excluded from scanning\n");
  const state = Buffer.from(
    JSON.stringify({
      resources: [
        {
          mode: "managed",
          type: "aws_instance",
          name: "web",
          instances: [{ attributes: { id: "i-remote" } }],
        },
      ],
    }),
  );
  const octokit = {
    paginate: async () => [
      {
        id: 7,
        name: "terraform.tfstate",
        state: "uploaded",
        size: state.length,
      },
    ],
    request: async () => ({ data: state }),
    rest: {
      git: {
        getRef: async ({ ref }: { ref: string }) => {
          if (ref !== "heads/main") {
            throw Object.assign(new Error("missing"), { status: 404 });
          }
          return { data: { object: { sha: "base-sha" } } };
        },
      },
      repos: {
        getReleaseByTag: async () => ({ data: { id: 1 } }),
        listReleaseAssets: "list",
        getContent: async () => ({
          data: {
            type: "file",
            content: Buffer.from(renderImports([])).toString("base64"),
          },
        }),
      },
      pulls: { list: async () => ({ data: [] }) },
    },
  } as never;
  const config = {
    operation: "import",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath: join(workspace, "unused.tfstate"),
    bootstrap: false,
    receiptPath: join(workspace, "receipt.json"),
    backupRetention: 20,
    sourceCommit: "",
    workflowRunId: "",
    resetTarget: "all",
    importsPath,
    terraformRoot,
    prBase: "main",
    prBranch: "terraform-release-state/imports.generated.tf",
    prTitle: "chore(terraform): update generated imports",
  } as never;

  try {
    process.env.GITHUB_OUTPUT = outputFile;
    await generateImports({ octokit, config });
    const outputs = readFileSync(outputFile, "utf8");
    assert.match(outputs, /import-candidate-count<<[^\n]+\n0\n/);
    assert.match(outputs, /import-skipped-count<<[^\n]+\n1\n/);
    assert.match(outputs, /import-collision-count<<[^\n]+\n1\n/);
    assert.equal(
      readFileSync(importsPath, "utf8"),
      "# generated file is excluded from scanning\n",
    );
  } finally {
    delete process.env.GITHUB_OUTPUT;
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("StateImport never reads a local imports symlink", () => {
  const workspace = mkdtempSync(
    join(tmpdir(), "terraform-release-state-import-link-"),
  );
  const outside = mkdtempSync(
    join(tmpdir(), "terraform-release-state-import-secret-"),
  );
  const outsideFile = join(outside, "secret.tf");
  const importsPath = join(workspace, "imports.generated.tf");
  writeFileSync(outsideFile, "EXTERNAL_IMPORT_CONTENT\n");
  symlinkSync(outsideFile, importsPath, "file");

  try {
    assert.throws(
      () => localImportsDiffBase(workspace, importsPath, false),
      /imports-path must not be a symbolic link/,
    );
    assert.equal(
      localImportsDiffBase(workspace, importsPath, true),
      "",
      "PR mode must not inspect the workspace imports path",
    );
  } finally {
    rmSync(workspace, { recursive: true, force: true });
    rmSync(outside, { recursive: true, force: true });
  }
});
