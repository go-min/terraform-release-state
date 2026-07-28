import { strict as assert } from "node:assert";
import { readFileSync } from "node:fs";
import { test } from "node:test";

const {
  ageRecipientsFingerprint,
  createManifest,
  parseManifest,
  serializeManifest,
  terraformMetadata,
} = await import(
  // @ts-expect-error This source module is compiled into the temporary native-test build.
  "../.test-build/src/manifest.mjs"
);

const fixture = readFileSync("tests/fixtures/manifest-v1.json");

test("manifest serializer is canonical and matches the golden fixture", () => {
  const parsed = parseManifest(fixture);
  assert.deepEqual(serializeManifest(parsed), fixture);
  assert.equal(parsed.object.name, "terraform.tfstate");
  assert.equal(
    parsed.terraform.lineage,
    "11111111-2222-3333-4444-555555555555",
  );
  assert.throws(
    () => serializeManifest({ ...parsed, extra: true } as never),
    /invalid/i,
  );
});

test("manifest parser rejects reordered, unknown, and unsupported fields", () => {
  const parsed = JSON.parse(fixture.toString("utf8"));
  const reordered = Buffer.from(
    `${JSON.stringify({ schema_version: 1, manifest: parsed.manifest, ...parsed }, null, 2)}\n`,
  );
  assert.throws(() => parseManifest(reordered), /canonical|invalid/i);

  const unknown = Buffer.from(
    `${JSON.stringify({ ...parsed, extra: true }, null, 2)}\n`,
  );
  assert.throws(() => parseManifest(unknown), /invalid/i);

  const unsupported = Buffer.from(
    `${JSON.stringify({ ...parsed, schema_version: 2 }, null, 2)}\n`,
  );
  assert.throws(
    () => parseManifest(unsupported),
    (error: unknown) =>
      error instanceof Error &&
      "code" in error &&
      error.code === "TRS_MANIFEST_UNSUPPORTED_VERSION",
  );
});

test("manifest records digests, Terraform correlation metadata, and age key set", () => {
  const plaintext = Buffer.from(
    JSON.stringify({
      terraform_version: "1.14.0",
      serial: 7,
      lineage: "lineage-id",
      resources: [{ sensitive: "not-in-manifest" }],
    }),
  );
  const fingerprint = ageRecipientsFingerprint(["age1z", "age1a"]);
  const manifest = createManifest({
    role: "current",
    name: "terraform.tfstate",
    stored: Buffer.from("ciphertext"),
    plaintext,
    encryptionMode: "age",
    encryptionKeyFingerprint: fingerprint,
    parentMarker: "opaque-marker",
    parentStoredSha256:
      "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
    sourceCommit: "commit",
    workflowRunId: "run",
    actionVersion: "v0.4.0",
    createdAt: "2026-07-28T12:34:56.789Z",
  });
  assert.deepEqual(manifest.terraform, {
    version: "1.14.0",
    serial: 7,
    lineage: "lineage-id",
  });
  assert.equal(JSON.stringify(manifest).includes("sensitive"), false);
  assert.equal(fingerprint, ageRecipientsFingerprint(["age1a", "age1z"]));
  assert.deepEqual(terraformMetadata(Buffer.from("not-json")), {
    version: null,
    serial: null,
    lineage: null,
  });
});
