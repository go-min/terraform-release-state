import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

const metadata = readFileSync("action.yml", "utf8");
const releasePleaseWorkflow = readFileSync(
  ".github/workflows/release-please.yml",
  "utf8",
);
const integrationWorkflow = readFileSync(
  ".github/workflows/integration.yml",
  "utf8",
);
const releasePleaseConfig = readFileSync("release-please-config.json", "utf8");
const prettierIgnore = readFileSync(".prettierignore", "utf8");
const markdownlintConfig = readFileSync(".markdownlint-cli2.yaml", "utf8");

describe("action metadata", () => {
  it("uses the Node 24 runtime and compiled bundle", () => {
    assert.match(metadata, /using: node24/);
    assert.match(metadata, /main: dist\/index\.js/);
  });

  it("exposes the stable restore/save API", () => {
    assert.match(metadata, /operation:/);
    assert.match(metadata, /expected-remote-state-marker:/);
    assert.match(metadata, /backup-retention:/);
    assert.match(metadata, /remote-state-marker:/);
    assert.match(metadata, /State operation: restore, save, reset, or import/);
    assert.match(metadata, /confirmation:/);
    assert.match(metadata, /encryption:/);
    assert.match(metadata, /age-recipients:/);
    assert.match(metadata, /age-identities:/);
    assert.match(metadata, /imports-path:/);
    assert.match(metadata, /default: \.\/imports\.generated\.tf/);
    assert.match(metadata, /terraform-root:/);
    assert.match(metadata, /create-pr:/);
    assert.match(metadata, /pr-base:/);
    assert.match(metadata, /pr-branch:/);
    assert.match(metadata, /import-pr-url:/);
    assert.match(metadata, /import-candidate-count:/);
    assert.match(metadata, /import-skipped-count:/);
    assert.match(metadata, /import-collision-count:/);
    assert.match(metadata, /import-pr-action:/);
    assert.match(metadata, /state-path:[\s\S]*required: false/);
    assert.match(metadata, /stored-state-sha256:/);
    assert.match(metadata, /plaintext-state-sha256:/);
    assert.match(metadata, /signature-policy:/);
    assert.match(metadata, /signing-private-key:/);
    assert.match(metadata, /verification-public-keys:/);
    assert.match(metadata, /storage-format:/);
    assert.match(metadata, /manifest-schema-version:/);
    assert.match(metadata, /signature-status:/);
    assert.match(metadata, /signature-key-fingerprint:/);
    assert.match(metadata, /stored-state-verification:/);
    assert.match(metadata, /plaintext-state-verification:/);
    assert.match(metadata, /warning-codes-json:/);
    assert.match(metadata, /error-code:/);
    assert.match(metadata, /state-write-committed:/);
    assert.match(metadata, /state-phase:/);
    assert.match(metadata, /state-status:/);
  });
});

describe("release lifecycle", () => {
  it("keeps Release Please lifecycle labeling enabled", () => {
    assert.doesNotMatch(releasePleaseWorkflow, /skip-labeling/);
  });

  it("excludes the generated changelog from generic formatters", () => {
    assert.match(releasePleaseConfig, /"changelog-path": "CHANGELOG\.md"/);
    assert.match(prettierIgnore, /^CHANGELOG\.md$/m);
    assert.match(markdownlintConfig, /^\s+- CHANGELOG\.md$/m);
  });

  it("gates publication on integration of the exact candidate SHA", () => {
    assert.match(integrationWorkflow, /^\s+workflow_call:$/m);
    assert.doesNotMatch(integrationWorkflow, /^\s+push:$/m);
    assert.ok(integrationWorkflow.includes("ref: $" + "{{ github.sha }}"));
    assert.ok(
      integrationWorkflow.includes(
        'run: test "$(git rev-parse HEAD)" = "$EXPECTED_SHA"',
      ),
    );
    assert.match(
      releasePleaseWorkflow,
      /integration:\n\s+permissions:\n\s+contents: write\n\s+uses: \.\/\.github\/workflows\/integration\.yml/,
    );
    assert.match(
      integrationWorkflow,
      /jobs:\n\s+integration:\n\s+permissions:\n\s+contents: write/,
    );
    assert.match(
      releasePleaseWorkflow,
      /release-please:[\s\S]*needs: integration/,
    );
    assert.match(releasePleaseWorkflow, /cancel-in-progress: true/);
    assert.ok(
      releasePleaseWorkflow.includes('test "$current_sha" = "$EXPECTED_SHA"'),
    );
  });
});
