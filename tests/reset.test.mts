import { strict as assert } from "node:assert";
import { test } from "node:test";
const { isResetAsset, resetWithClient, resetAssets } = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/reset-core.mjs"
);

const config = {
  operation: "reset",
  token: "token",
  target: { owner: "go-min", repo: "state" },
  tag: "terraform-state",
  assetName: "terraform.tfstate",
  statePath: "/workspace/unused",
  bootstrap: false,
  receiptPath: "/runner/receipt.json",
  backupRetention: 20,
  sourceCommit: "",
  workflowRunId: "",
  resetTarget: "all",
} as never;

const asset = (id: number, name: string) =>
  ({
    id,
    name,
    state: "uploaded",
  }) as never;

const release = { id: 7 } as never;

test("reset only recognizes current state and backup namespace", () => {
  assert.equal(isResetAsset("terraform.tfstate", "terraform.tfstate"), true);
  assert.equal(
    isResetAsset("terraform.tfstate.metadata.json", "terraform.tfstate"),
    true,
  );
  assert.equal(
    isResetAsset("terraform.tfstate.manifest.json", "terraform.tfstate"),
    true,
  );
  assert.equal(
    isResetAsset("terraform.tfstate.manifest.sig.json", "terraform.tfstate"),
    true,
  );
  assert.equal(
    isResetAsset(
      "terraform.tfstate.backup-a.manifest.sig.json",
      "terraform.tfstate",
    ),
    true,
  );
  assert.equal(
    isResetAsset(
      "terraform.tfstate.backup-20260725T120000Z",
      "terraform.tfstate",
    ),
    true,
  );
  assert.equal(
    isResetAsset("terraform.tfstate.other", "terraform.tfstate"),
    false,
  );
  assert.deepEqual(
    resetAssets(
      [
        asset(1, "terraform.tfstate"),
        asset(2, "terraform.tfstate.metadata.json"),
        asset(3, "terraform.tfstate.backup-a"),
        asset(4, "unrelated.zip"),
      ],
      "terraform.tfstate",
    ),
    {
      owned: [
        asset(1, "terraform.tfstate"),
        asset(2, "terraform.tfstate.metadata.json"),
        asset(3, "terraform.tfstate.backup-a"),
      ],
      unexpected: [asset(4, "unrelated.zip")],
    },
  );
});

test("reset deletes assets, release, and tag through the client", async () => {
  const calls: string[] = [];
  let listed = false;
  const result = await resetWithClient({ config } as never, {
    getRelease: async () => release,
    listAssets: async () => {
      if (listed) return [];
      listed = true;
      return [
        asset(1, "terraform.tfstate"),
        asset(2, "terraform.tfstate.backup-a"),
      ];
    },
    deleteAsset: async (_target: unknown, id: number) => {
      calls.push(`asset:${id}`);
    },
    deleteRelease: async (_target: unknown, id: number) => {
      calls.push(`release:${id}`);
    },
    deleteTag: async (_target: unknown, tag: string) => {
      calls.push(`tag:${tag}`);
    },
  });
  assert.deepEqual(result, {
    deletedAssetCount: 2,
    releaseFound: true,
    action: "deleted",
    target: "all",
  });
  assert.deepEqual(calls, [
    "asset:1",
    "asset:2",
    "release:7",
    "tag:terraform-state",
  ]);
});

test("reset refuses to delete the release when assets appear after its audit", async () => {
  const calls: string[] = [];
  let listed = false;
  await assert.rejects(
    resetWithClient({ config } as never, {
      getRelease: async () => release,
      listAssets: async () => {
        if (listed) return [asset(9, "unrelated.zip")];
        listed = true;
        return [asset(1, "terraform.tfstate")];
      },
      deleteAsset: async (_target: unknown, id: number) => {
        calls.push(`asset:${id}`);
      },
      deleteRelease: async () => {
        calls.push("release");
      },
      deleteTag: async () => {
        calls.push("tag");
      },
    }),
    /changed during reset/,
  );
  assert.deepEqual(calls, ["asset:1"]);
});

test("reset fails closed before deleting when release has unrelated assets", async () => {
  const calls: string[] = [];
  await assert.rejects(
    resetWithClient({ config } as never, {
      getRelease: async () => release,
      listAssets: async () => [
        asset(1, "terraform.tfstate"),
        asset(9, "unrelated.zip"),
      ],
      deleteAsset: async () => {
        calls.push("asset");
      },
      deleteRelease: async () => {
        calls.push("release");
      },
      deleteTag: async () => {
        calls.push("tag");
      },
    }),
    /non-state assets/,
  );
  assert.deepEqual(calls, []);
});

test("reset runs compatibility preflight before the first deletion", async () => {
  const calls: string[] = [];
  await assert.rejects(
    resetWithClient({ config } as never, {
      getRelease: async () => release,
      listAssets: async () => [asset(1, "terraform.tfstate")],
      beforeDelete: async () => {
        calls.push("preflight");
        throw new Error("migration required");
      },
      deleteAsset: async () => {
        calls.push("asset");
      },
      deleteRelease: async () => {
        calls.push("release");
      },
      deleteTag: async () => {
        calls.push("tag");
      },
    }),
    /migration required/,
  );
  assert.deepEqual(calls, ["preflight"]);
});

test("reset is idempotent when the release is already absent", async () => {
  const calls: string[] = [];
  const result = await resetWithClient({ config } as never, {
    getRelease: async () => undefined,
    listAssets: async () => [],
    deleteAsset: async () => {
      calls.push("asset");
    },
    deleteRelease: async () => {
      calls.push("release");
    },
    deleteTag: async () => {
      calls.push("tag");
    },
  });
  assert.deepEqual(result, {
    deletedAssetCount: 0,
    releaseFound: false,
    action: "unchanged",
    target: "all",
  });
  assert.deepEqual(calls, ["tag"]);
});

test("partial deletion stops and can be retried safely", async () => {
  const calls: string[] = [];
  await assert.rejects(
    resetWithClient({ config } as never, {
      getRelease: async () => release,
      listAssets: async () => [
        asset(1, "terraform.tfstate"),
        asset(2, "terraform.tfstate.backup-a"),
      ],
      deleteAsset: async (_target: unknown, id: number) => {
        calls.push(`asset:${id}`);
        if (id === 2) throw new Error("temporary delete failure");
      },
      deleteRelease: async () => {
        calls.push("release");
      },
      deleteTag: async () => {
        calls.push("tag");
      },
    }),
    /temporary delete failure/,
  );
  assert.deepEqual(calls, ["asset:1", "asset:2"]);
});
