import { strict as assert } from "node:assert";
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { test } from "node:test";

const testModulePath: string = "../.test-build/src/imports.mjs";
const { candidatesFromState, generateImports, renderImports } = await import(
  testModulePath
);

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
  const statePath = join(workspace, "not-created.tfstate");
  const importsPath = join(workspace, "imports.tf");
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
  writeFileSync(importsPath, "# existing\n");
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
      repos: {
        getReleaseByTag: async () => ({ data: { id: 1 } }),
        listReleaseAssets: "list",
      },
    },
  } as never;
  const config = {
    operation: "import",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    prTarget: { owner: "go-min", repo: "state" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath,
    bootstrap: false,
    expectedMarker: "",
    backupRetention: 20,
    sourceCommit: "",
    workflowRunId: "",
    resetConfirmation: "",
    importsPath,
    createPr: false,
    prBase: "main",
    prBranch: "terraform-release-state/imports.tf",
    prTitle: "chore(terraform): update generated imports",
    encryption: { mode: "none", recipients: [], identities: [] },
  } as never;

  try {
    await generateImports({ octokit, config });
    assert.equal(readFileSync(importsPath, "utf8"), "# existing\n");
    assert.equal(existsSync(statePath), false);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});

test("StateImport creates one pull request from the remote base diff", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "terraform-release-state-pr-"));
  const state = Buffer.from(
    JSON.stringify({
      resources: [
        {
          mode: "managed",
          type: "aws_instance",
          name: "web",
          instances: [{ attributes: { id: "i-pr" } }],
        },
      ],
    }),
  );
  const baseContent = Buffer.from("# base imports\n");
  const calls: Array<{ method: string; options: Record<string, unknown> }> = [];
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
        getRef: async (options: Record<string, unknown>) => {
          calls.push({ method: "getRef", options });
          return { data: { object: { sha: "base-sha" } } };
        },
        createRef: async (options: Record<string, unknown>) => {
          calls.push({ method: "createRef", options });
          return { data: { object: { sha: "branch-sha" } } };
        },
      },
      repos: {
        getReleaseByTag: async () => ({ data: { id: 1 } }),
        listReleaseAssets: "list",
        getContent: async (options: Record<string, unknown>) => {
          calls.push({ method: "getContent", options });
          if (options.ref === "main") {
            return {
              data: {
                type: "file",
                content: baseContent.toString("base64"),
                sha: "base-file-sha",
              },
            };
          }
          throw Object.assign(new Error("missing branch file"), {
            status: 404,
          });
        },
        createOrUpdateFileContents: async (
          options: Record<string, unknown>,
        ) => {
          calls.push({ method: "updateFile", options });
          return { data: {} };
        },
      },
      pulls: {
        list: async (options: Record<string, unknown>) => {
          calls.push({ method: "listPulls", options });
          return { data: [] };
        },
        create: async (options: Record<string, unknown>) => {
          calls.push({ method: "createPull", options });
          return {
            data: {
              html_url: "https://github.com/go-min/state/pull/1",
              number: 1,
            },
          };
        },
      },
    },
  } as never;
  const config = {
    operation: "import",
    token: "token",
    target: { owner: "go-min", repo: "state" },
    prTarget: { owner: "go-min", repo: "consumer" },
    tag: "terraform-state",
    assetName: "terraform.tfstate",
    workspace,
    statePath: join(workspace, "unused.tfstate"),
    bootstrap: false,
    expectedMarker: "",
    backupRetention: 20,
    sourceCommit: "",
    workflowRunId: "",
    resetConfirmation: "",
    importsPath: join(workspace, "imports.tf"),
    createPr: true,
    prBase: "main",
    prBranch: "terraform-release-state/imports.tf",
    prTitle: "chore(terraform): update generated imports",
    encryption: { mode: "none", recipients: [], identities: [] },
  } as never;

  try {
    await generateImports({ octokit, config });
    const update = calls.find((call) => call.method === "updateFile");
    const createPull = calls.find((call) => call.method === "createPull");
    assert.ok(update);
    assert.equal(update.options.branch, "terraform-release-state/imports.tf");
    assert.equal(update.options.path, "imports.tf");
    assert.equal(update.options.sha, undefined);
    assert.ok(createPull);
    assert.equal(createPull.options.base, "main");
    assert.equal(createPull.options.head, "terraform-release-state/imports.tf");
    assert.equal(createPull.options.repo, "consumer");
    assert.match(String(createPull.options.title), /generated imports/);
    assert.match(String(createPull.options.body), /Terraform import proposal/);
    assert.match(String(createPull.options.body), /Review checklist/);
    assert.match(String(createPull.options.body), /Safety boundary/);
    assert.match(String(createPull.options.body), /Import candidates.*1/);
    assert.match(
      String(createPull.options.body),
      /State repository \| `go-min\/state`/,
    );
    assert.match(
      String(createPull.options.body),
      /Target repository \| `go-min\/consumer`/,
    );
    assert.doesNotMatch(String(createPull.options.body), /i-pr/);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
});
