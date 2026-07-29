import { strict as assert } from "node:assert";
import { test } from "node:test";

const { prepareImportPullRequest } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/import-pr.mjs"
);
const { inspectBranchDiff } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/github-api.mjs"
);

type Call = { method: string; options: Record<string, unknown> };
type TreeEntry = {
  mode: string;
  path: string;
  sha: string;
  type: "blob";
};

function importContext(options: {
  baseContent?: Buffer;
  concurrentDuringUpdate?: boolean;
  existingPr?: boolean;
  missingBranch?: boolean;
  unrelatedPath?: string;
}) {
  const calls: Call[] = [];
  const trees = new Map<string, TreeEntry[]>([
    [
      "old-base-tree",
      [
        { mode: "100644", path: "README.md", sha: "readme-old", type: "blob" },
        {
          mode: "100644",
          path: "imports.generated.tf",
          sha: "imports-base-old",
          type: "blob",
        },
      ],
    ],
    [
      "current-base-tree",
      [
        { mode: "100644", path: "README.md", sha: "readme-new", type: "blob" },
        {
          mode: "100644",
          path: "imports.generated.tf",
          sha: "imports-base-current",
          type: "blob",
        },
      ],
    ],
    [
      "stale-tree",
      [
        { mode: "100644", path: "README.md", sha: "readme-old", type: "blob" },
        {
          mode: "100644",
          path: "imports.generated.tf",
          sha: "imports-stale-generated",
          type: "blob",
        },
        ...(options.unrelatedPath
          ? [
              {
                mode: "100644" as const,
                path: options.unrelatedPath,
                sha: "unrelated-change",
                type: "blob" as const,
              },
            ]
          : []),
      ],
    ],
    [
      "concurrent-tree",
      [
        {
          mode: "100644",
          path: "concurrent.txt",
          sha: "concurrent-change",
          type: "blob",
        },
      ],
    ],
  ]);
  const commits = new Map<string, string>([
    ["old-base", "old-base-tree"],
    ["current-base", "current-base-tree"],
    ["stale-head", "stale-tree"],
    ["concurrent-head", "concurrent-tree"],
  ]);
  let branchSha: string | undefined = options.missingBranch
    ? undefined
    : "stale-head";
  let branchRefReads = 0;
  let refreshedParents: string[] = [];

  const octokit = {
    rest: {
      git: {
        getRef: async (request: Record<string, unknown>) => {
          calls.push({ method: "getRef", options: request });
          if (request.ref !== "heads/main") {
            branchRefReads += 1;
            if (options.concurrentDuringUpdate && branchRefReads >= 2) {
              branchSha = "concurrent-head";
            }
          }
          if (request.ref !== "heads/main" && !branchSha) {
            throw Object.assign(new Error("missing ref"), { status: 404 });
          }
          return {
            data: {
              object: {
                sha: request.ref === "heads/main" ? "current-base" : branchSha,
              },
            },
          };
        },
        createRef: async (request: Record<string, unknown>) => {
          calls.push({ method: "createRef", options: request });
          branchSha = String(request.sha);
          return { data: { object: { sha: branchSha } } };
        },
        getCommit: async (request: Record<string, unknown>) => {
          calls.push({ method: "getCommit", options: request });
          const tree = commits.get(String(request.commit_sha));
          assert.ok(tree, `missing commit ${String(request.commit_sha)}`);
          return { data: { tree: { sha: tree } } };
        },
        getTree: async (request: Record<string, unknown>) => {
          calls.push({ method: "getTree", options: request });
          const tree = trees.get(String(request.tree_sha));
          assert.ok(tree, `missing tree ${String(request.tree_sha)}`);
          return { data: { tree, truncated: false } };
        },
        createBlob: async (request: Record<string, unknown>) => {
          calls.push({ method: "createBlob", options: request });
          return { data: { sha: "generated-blob" } };
        },
        createTree: async (request: Record<string, unknown>) => {
          calls.push({ method: "createTree", options: request });
          assert.equal(request.base_tree, "current-base-tree");
          trees.set("desired-tree", [
            {
              mode: "100644",
              path: "README.md",
              sha: "readme-new",
              type: "blob",
            },
            {
              mode: "100644",
              path: "imports.generated.tf",
              sha: "generated-blob",
              type: "blob",
            },
          ]);
          return { data: { sha: "desired-tree" } };
        },
        createCommit: async (request: Record<string, unknown>) => {
          calls.push({ method: "createCommit", options: request });
          refreshedParents = request.parents as string[];
          commits.set("refreshed-head", String(request.tree));
          return { data: { sha: "refreshed-head" } };
        },
        updateRef: async (request: Record<string, unknown>) => {
          calls.push({ method: "updateRef", options: request });
          assert.equal(request.force, false);
          assert.equal(
            branchSha,
            refreshedParents[0],
            "expected-head lease changed",
          );
          branchSha = String(request.sha);
          return { data: { object: { sha: branchSha } } };
        },
      },
      repos: {
        getContent: async (request: Record<string, unknown>) => {
          calls.push({ method: "getContent", options: request });
          assert.equal(request.ref, "current-base");
          const content = options.baseContent || Buffer.from("# base\n");
          return {
            data: {
              type: "file",
              content: content.toString("base64"),
              sha: "base-file-sha",
            },
          };
        },
        compareCommitsWithBasehead: async (
          request: Record<string, unknown>,
        ) => {
          calls.push({ method: "compare", options: request });
          const head = String(request.basehead).split("...")[1];
          return {
            data: {
              head_commit: { sha: head },
              merge_base_commit: {
                sha: head === "refreshed-head" ? "current-base" : "old-base",
              },
            },
          };
        },
      },
      pulls: {
        list: async (request: Record<string, unknown>) => {
          calls.push({ method: "listPulls", options: request });
          return {
            data: options.existingPr
              ? [
                  {
                    html_url: "https://github.com/go-min/consumer/pull/7",
                    number: 7,
                  },
                ]
              : [],
          };
        },
        create: async (request: Record<string, unknown>) => {
          calls.push({ method: "createPull", options: request });
          return {
            data: {
              html_url: "https://github.com/go-min/consumer/pull/8",
              number: 8,
            },
          };
        },
        update: async (request: Record<string, unknown>) => {
          calls.push({ method: "updatePull", options: request });
          return { data: {} };
        },
      },
    },
  } as never;
  const config = {
    operation: "import",
    target: { owner: "go-min", repo: "consumer" },
    tag: "terraform-state",
    workspace: "/workspace",
    terraformRoot: "/workspace/terraform",
    prBase: "main",
    prBranch: "terraform-release-state/imports.generated.tf",
    prTitle: "chore(terraform): update generated imports",
  } as never;

  return {
    calls,
    context: { octokit, config },
    octokit,
    refreshedParents: () => refreshedParents,
    branchSha: () => branchSha,
  };
}

test("ImportPR refreshes a stale action-only branch from current base", async () => {
  const fixture = importContext({});
  const generated = Buffer.from("# generated\n");

  const result = await prepareImportPullRequest(
    fixture.context,
    "imports.generated.tf",
    generated,
    1,
    0,
    0,
  );

  assert.equal(result.action, "created");
  assert.deepEqual(fixture.refreshedParents(), ["stale-head", "current-base"]);
  const refUpdate = fixture.calls.find((call) => call.method === "updateRef");
  assert.equal(refUpdate?.options.force, false);
  assert.equal(fixture.branchSha(), "refreshed-head");
  const comparison = await inspectBranchDiff(
    fixture.octokit,
    { owner: "go-min", repo: "consumer" },
    "current-base",
    "refreshed-head",
  );
  assert.equal(comparison.baseIsAncestor, true);
  assert.deepEqual(
    comparison.changedPaths,
    ["imports.generated.tf"],
    "current-base changes must not be replayed in the refreshed PR diff",
  );
});

test("ImportPR creates a missing automation branch from current base", async () => {
  const fixture = importContext({ missingBranch: true });

  const result = await prepareImportPullRequest(
    fixture.context,
    "imports.generated.tf",
    Buffer.from("# generated\n"),
    1,
    0,
    0,
  );

  assert.equal(result.action, "created");
  assert.deepEqual(fixture.refreshedParents(), ["current-base"]);
  assert.equal(
    fixture.calls.some((call) => call.method === "createRef"),
    true,
  );
});

test("ImportPR refuses to overwrite an unrelated changed path", async () => {
  const fixture = importContext({ unrelatedPath: "notes.txt" });

  await assert.rejects(
    prepareImportPullRequest(
      fixture.context,
      "imports.generated.tf",
      Buffer.from("# generated\n"),
      1,
      0,
      0,
    ),
    /changes unrelated path\(s\).*notes\.txt.*refusing to overwrite/,
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "createCommit"),
    false,
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "updateRef"),
    false,
  );
});

test("ImportPR refuses a branch that moves after its diff inspection", async () => {
  const fixture = importContext({ concurrentDuringUpdate: true });

  await assert.rejects(
    prepareImportPullRequest(
      fixture.context,
      "imports.generated.tf",
      Buffer.from("# generated\n"),
      1,
      0,
      0,
    ),
    /changed from expected SHA stale-head to concurrent-head during refresh; refusing to overwrite/,
  );
  assert.equal(
    fixture.calls.some((call) => call.method === "updateRef"),
    false,
  );
});

test("ImportPR refreshes an existing PR without creating another", async () => {
  const fixture = importContext({ existingPr: true });
  const result = await prepareImportPullRequest(
    fixture.context,
    "imports.generated.tf",
    Buffer.from("# generated\n"),
    2,
    1,
    1,
  );

  assert.equal(result.action, "updated");
  assert.equal(
    fixture.calls.some((call) => call.method === "createPull"),
    false,
  );
  const update = fixture.calls.find((call) => call.method === "updatePull");
  assert.equal(update?.options.pull_number, 7);
  assert.match(String(update?.options.body), /Import candidates.*2/);
  assert.match(String(update?.options.body), /Existing-target collisions.*1/);
  assert.doesNotMatch(String(update?.options.body), /\/workspace/);
});

test("ImportPR closes an obsolete action-only PR and retains its branch", async () => {
  const baseContent = Buffer.from("# already generated\n");
  const fixture = importContext({ baseContent, existingPr: true });
  const result = await prepareImportPullRequest(
    fixture.context,
    "imports.generated.tf",
    baseContent,
    0,
    0,
    0,
  );

  assert.equal(result.action, "closed");
  const update = fixture.calls.find((call) => call.method === "updatePull");
  assert.equal(update?.options.state, "closed");
  assert.equal(
    fixture.calls.some((call) => call.method === "deleteRef"),
    false,
  );
});
