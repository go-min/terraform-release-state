import { strict as assert } from "node:assert";
import { test, type TestContext } from "node:test";
const {
  deleteAsset,
  deleteRelease,
  deleteTag,
  downloadAsset,
  createRelease,
  getRelease,
  listAssets,
  managedReleaseBody,
  updateReleaseBody,
  uploadAsset,
} = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/github-api.mjs"
);

const target = { owner: "go-min", repo: "state" };
const failure = (
  status: number,
  response?: {
    data?: { message?: string };
    headers?: Record<string, string>;
  },
) => Object.assign(new Error(`HTTP ${status}`), { status, response });

function captureRetryDelays(context: TestContext): number[] {
  const delays: number[] = [];
  context.mock.method(
    globalThis,
    "setTimeout",
    (callback: () => void, delay = 0) => {
      delays.push(delay);
      callback();
      return {} as NodeJS.Timeout;
    },
  );
  return delays;
}

test("getRelease treats a missing release as absent", async () => {
  const octokit = {
    rest: {
      repos: {
        getReleaseByTag: async () => {
          throw failure(404);
        },
      },
    },
  } as never;
  assert.equal(await getRelease(octokit, target, "terraform-state"), undefined);
});

test("getRelease preserves permission errors", async () => {
  const octokit = {
    rest: {
      repos: {
        getReleaseByTag: async () => {
          throw failure(403);
        },
      },
    },
  } as never;
  await assert.rejects(
    getRelease(octokit, target, "terraform-state"),
    /HTTP 403/,
  );
});

test("listAssets uses pagination through the internal API client", async () => {
  const calls: unknown[] = [];
  const octokit = {
    paginate: async (method: unknown, params: unknown) => {
      calls.push([method, params]);
      return [{ id: 1 }, { id: 2 }];
    },
    rest: { repos: { listReleaseAssets: "list" } },
  } as never;
  const assets = await listAssets(octokit, target, 12);
  assert.equal(assets.length, 2);
  assert.deepEqual(calls, [
    ["list", { ...target, release_id: 12, per_page: 100 }],
  ]);
});

test("deletions retry transient failures", async (context) => {
  const delays = captureRetryDelays(context);
  let attempts = 0;
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async () => {
          attempts += 1;
          if (attempts < 2) throw failure(503);
        },
        deleteRelease: async () => undefined,
      },
      git: { deleteRef: async () => undefined },
    },
  } as never;
  await deleteAsset(octokit, target, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});

test("reads retry transient network failures", async (context) => {
  const delays = captureRetryDelays(context);
  let attempts = 0;
  const octokit = {
    paginate: async () => {
      attempts += 1;
      if (attempts === 1) {
        throw Object.assign(new Error("socket closed"), {
          cause: { code: "UND_ERR_SOCKET" },
        });
      }
      return [];
    },
    rest: { repos: { listReleaseAssets: "list" } },
  } as never;

  assert.deepEqual(await listAssets(octokit, target, 12), []);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [500]);
});

test("primary rate-limit 403 waits until the reset header", async (context) => {
  const delays = captureRetryDelays(context);
  context.mock.method(Date, "now", () => 1_000_000);
  const reset = 1002;
  let attempts = 0;
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw failure(403, {
              headers: {
                "x-ratelimit-remaining": "0",
                "x-ratelimit-reset": String(reset),
              },
            });
          }
        },
      },
    },
  } as never;

  await deleteAsset(octokit, target, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [2000]);
});

test("rate-limit 429 respects Retry-After", async (context) => {
  const delays = captureRetryDelays(context);
  let attempts = 0;
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async () => {
          attempts += 1;
          if (attempts === 1) {
            throw failure(429, { headers: { "retry-after": "3" } });
          }
        },
      },
    },
  } as never;

  await deleteAsset(octokit, target, 1);
  assert.equal(attempts, 2);
  assert.deepEqual(delays, [3000]);
});

test("downloadAsset rejects a digest mismatch without exposing content", async () => {
  const octokit = {
    request: async () => ({ data: Buffer.from("unexpected") }),
  } as never;
  const asset = {
    id: 1,
    name: "terraform.tfstate",
    size: 10,
    digest:
      "sha256:0000000000000000000000000000000000000000000000000000000000000000",
  } as never;
  await assert.rejects(
    downloadAsset(octokit, target, asset),
    /Integrity check failed/,
  );
});

test("uploadAsset uses the release asset API and content length", async () => {
  let request: unknown;
  const octokit = {
    rest: {
      repos: {
        uploadReleaseAsset: async (options: unknown) => {
          request = options;
          return { data: { id: 3, name: "terraform.tfstate" } };
        },
      },
    },
  } as never;
  const data = Buffer.from("state");
  const result = await uploadAsset(
    octokit,
    target,
    12,
    "terraform.tfstate",
    data,
  );
  assert.deepEqual(result, { id: 3, name: "terraform.tfstate" });
  assert.deepEqual(request, {
    ...target,
    release_id: 12,
    name: "terraform.tfstate",
    data: data as unknown as string,
    headers: {
      "content-type": "application/octet-stream",
      "content-length": 5,
    },
  });
});

test("createRelease reconciles a release created before an ambiguous error", async () => {
  const octokit = {
    rest: {
      repos: {
        createRelease: async () => {
          throw failure(422);
        },
        getReleaseByTag: async () => ({
          data: { id: 12, tag_name: "terraform-state" },
        }),
      },
    },
  } as never;
  assert.deepEqual(
    await createRelease(
      octokit,
      target,
      "terraform-state",
      "terraform.tfstate",
    ),
    {
      id: 12,
      tag_name: "terraform-state",
    },
  );
});

test("createRelease documents the managed state without exposing its contents", async () => {
  let request: Record<string, unknown> | undefined;
  const octokit = {
    rest: {
      repos: {
        createRelease: async (options: Record<string, unknown>) => {
          request = options;
          return { data: { id: 12, tag_name: "terraform-state" } };
        },
      },
    },
  } as never;

  await createRelease(octokit, target, "terraform-state", "terraform.tfstate");

  const body = String(request?.body);
  assert.match(body, /\[!CAUTION\]/);
  assert.match(body, /Service release for Terraform state; do not delete\./);
  assert.match(body, /`go-min\/state`/);
  assert.match(body, /`terraform-state`/);
  assert.match(body, /`terraform\.tfstate`/);
  assert.match(body, /`terraform\.tfstate\.backup-\*`/);
  assert.match(
    body,
    /plaintext unsigned state.*optional cryptographic protections/s,
  );
  assert.match(body, /retains 20 verified backups/);
  assert.match(body, /github\.com\/go-min\/terraform-release-state/);
  assert.doesNotMatch(body, /state-sha256|credentials|age encryption/i);
});

test("updateReleaseBody updates the managed release description", async () => {
  let request: Record<string, unknown> | undefined;
  const octokit = {
    rest: {
      repos: {
        updateRelease: async (options: Record<string, unknown>) => {
          request = options;
          return { data: { id: 12, body: String(options.body) } };
        },
      },
    },
  } as never;
  const body = managedReleaseBody(
    target,
    "terraform-state",
    "terraform.tfstate",
  );

  const result = await updateReleaseBody(octokit, target, 12, body);

  assert.equal(result.id, 12);
  assert.deepEqual(request, { ...target, release_id: 12, body });
});

test("uploadAsset reconciles an asset created before an ambiguous error", async () => {
  const data = Buffer.from("state");
  const octokit = {
    paginate: async () => [
      {
        id: 3,
        name: "terraform.tfstate",
        state: "uploaded",
        size: data.length,
        digest:
          "sha256:4ba69735ca53765ed6a709edb56c6ea236b7193a3b29a6b390c346f0f4340e4e",
      },
    ],
    request: async () => ({ data }),
    rest: {
      repos: {
        listReleaseAssets: "list",
        uploadReleaseAsset: async () => {
          throw failure(503);
        },
      },
    },
  } as never;
  assert.equal(
    (await uploadAsset(octokit, target, 12, "terraform.tfstate", data)).id,
    3,
  );
});

test("retry stops after the bounded transient retry budget", async (context) => {
  const delays = captureRetryDelays(context);
  let attempts = 0;
  const octokit = {
    rest: {
      repos: {
        deleteRelease: async () => {
          attempts += 1;
          throw failure(503);
        },
      },
    },
  } as never;
  await assert.rejects(deleteRelease(octokit, target, 12), /HTTP 503/);
  assert.equal(attempts, 5);
  assert.deepEqual(delays, [500, 1000, 2000, 4000]);
});

test("deletions treat 404 as already absent", async () => {
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async () => {
          throw failure(404);
        },
        deleteRelease: async () => {
          throw failure(404);
        },
      },
      git: {
        deleteRef: async () => {
          throw failure(404);
        },
      },
    },
  } as never;
  await deleteAsset(octokit, target, 1);
  await deleteRelease(octokit, target, 2);
  await deleteTag(octokit, target, "terraform-state");
});

test("non-retryable deletion failures remain errors", async () => {
  let attempts = 0;
  const octokit = {
    rest: {
      repos: {
        deleteReleaseAsset: async () => {
          attempts += 1;
          throw failure(403);
        },
      },
    },
  } as never;
  await assert.rejects(deleteAsset(octokit, target, 1), /HTTP 403/);
  assert.equal(attempts, 1);
});
