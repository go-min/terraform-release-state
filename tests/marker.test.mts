import { strict as assert } from "node:assert";
import { test } from "node:test";
import {
  assetDigest,
  decodeMarker,
  marker,
  sameMarker,
  sha256,
  // @ts-expect-error Node's native TypeScript runner resolves this source path directly.
} from "../src/marker.mts";

const asset = {
  id: 42,
  name: "terraform.tfstate",
  digest: "sha256:abc123",
  size: 12,
  updated_at: "2026-07-25T10:00:00Z",
} as never;

test("state markers are opaque and stable", () => {
  const encoded = marker(asset);
  assert.notEqual(encoded, "terraform.tfstate");
  assert.deepEqual(decodeMarker(encoded), {
    id: 42,
    name: "terraform.tfstate",
    digest: "abc123",
    size: 12,
    updatedAt: "2026-07-25T10:00:00Z",
  });
  assert.equal(assetDigest(asset), "abc123");
  assert.equal(sameMarker(decodeMarker(encoded) as never, asset), true);
});

test("state markers reject malformed values", () => {
  assert.equal(decodeMarker("absent"), "absent");
  assert.throws(() => decodeMarker("not-a-marker"), /Invalid/);
  assert.throws(
    () =>
      decodeMarker(
        Buffer.from(JSON.stringify({ id: 1 })).toString("base64url"),
      ),
    /Invalid/,
  );
});

test("state checksums are SHA-256", () => {
  assert.equal(
    sha256(Buffer.from("terraform-state")),
    "08ca218dae1431a97d74e2100a7336f8629dc52222afdc34a85702a8176d79bf",
  );
});
