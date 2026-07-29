import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

const metadata = readFileSync("action.yml", "utf8");
const packageJson = JSON.parse(readFileSync("package.json", "utf8")) as {
  scripts: { build: string };
};
const buildConfig = JSON.parse(readFileSync("tsconfig.build.json", "utf8")) as {
  compilerOptions: { incremental: boolean };
};
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
const commitlintConfig = readFileSync("commitlint.config.mjs", "utf8");

describe("action metadata", () => {
  it("uses the Node 24 runtime and compiled bundle", () => {
    assert.match(metadata, /using: node24/);
    assert.match(metadata, /main: dist\/index\.js/);
  });

  it("exposes exactly the v0.5 three-input API", () => {
    const inputs = metadata.match(/^inputs:\n([\s\S]*?)^outputs:/m)?.[1] || "";
    assert.deepEqual(
      [...inputs.matchAll(/^ {2}([a-z0-9-]+):$/gm)].map((match) => match[1]),
      ["operation", "github-token", "reset-target"],
    );
    assert.match(inputs, /reset-target:[\s\S]*default: all/);
    assert.match(metadata, /remote-state-marker:/);
    assert.match(metadata, /import-pr-url:/);
    assert.match(metadata, /import-candidate-count:/);
    assert.match(metadata, /import-skipped-count:/);
    assert.match(metadata, /import-collision-count:/);
    assert.match(metadata, /import-pr-action:/);
    assert.match(metadata, /stored-state-sha256:/);
    assert.match(metadata, /plaintext-state-sha256:/);
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
    assert.match(metadata, /reset-action:/);
    assert.match(metadata, /reset-target:/);
    assert.match(metadata, /reset-promoted-marker:/);
  });
});

describe("release lifecycle", () => {
  it("rebuilds dist without stale ncc dependency cache", () => {
    assert.match(
      packageJson.scripts.build,
      /rm -rf \.build.*XDG_CACHE_HOME="\$PWD\/\.build\/\.cache" ncc build .* --no-cache/,
    );
    assert.equal(buildConfig.compilerOptions.incremental, false);
  });

  it("keeps Release Please lifecycle labeling enabled", () => {
    assert.doesNotMatch(releasePleaseWorkflow, /skip-labeling/);
  });

  it("accepts generated Release Please URL footers without weakening headers", () => {
    assert.match(commitlintConfig, /'footer-max-line-length': \[0\]/);
    assert.match(commitlintConfig, /@commitlint\/config-conventional/);
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
      integrationWorkflow,
      /actions\/checkout@3d3c42e5aac5ba805825da76410c181273ba90b1/,
    );
    assert.match(
      releasePleaseWorkflow,
      /integration:\n\s+permissions:\n\s+contents: write\n\s+uses: \.\/\.github\/workflows\/integration\.yml/,
    );
    assert.match(
      integrationWorkflow,
      /jobs:\n\s+integration:\n\s+permissions:\n\s+contents: write/,
    );
    assert.match(integrationWorkflow, /node tests\/integration-action\.mjs/);
    assert.match(
      releasePleaseWorkflow,
      /release-please:[\s\S]*needs: integration/,
    );
    assert.match(releasePleaseWorkflow, /cancel-in-progress: true/);
    assert.ok(
      releasePleaseWorkflow.includes('test "$current_sha" = "$EXPECTED_SHA"'),
    );
  });

  it("guards and cleans the fixed live Release integration namespace", () => {
    const fixture = integrationWorkflow.indexOf(
      "Run deterministic action-boundary integration",
    );
    const preflight = integrationWorkflow.indexOf(
      "Assert fixed live namespace is absent",
    );
    const bootstrap = integrationWorkflow.indexOf(
      "Bootstrap fixed state storage",
    );
    const save = integrationWorkflow.indexOf("Save plaintext state");
    const restore = integrationWorkflow.indexOf("Restore saved state");
    const reset = integrationWorkflow.indexOf(
      "Reset fixed live integration storage",
    );
    const finalAssertion = integrationWorkflow.indexOf(
      "Assert fixed live namespace was removed",
    );

    assert.ok(
      fixture >= 0 &&
        fixture < preflight &&
        preflight < bootstrap &&
        bootstrap < save &&
        save < restore &&
        restore < reset &&
        reset < finalAssertion,
    );
    assert.match(
      integrationWorkflow,
      /release_status.*404[\s\S]*tag_status.*404/,
    );
    assert.match(integrationWorkflow, /permissions:\n\s+contents: read/);
    assert.match(
      integrationWorkflow,
      /ref='refs\/tags\/terraform-state'[\s\S]*sha="\$EXPECTED_SHA"/,
    );
    assert.match(
      integrationWorkflow,
      /TERRAFORM_BOOTSTRAP: "true"[\s\S]*operation: restore/,
    );
    assert.match(
      integrationWorkflow,
      /operation: reset[\s\S]*reset-target: all/,
    );
    assert.match(
      integrationWorkflow,
      /current_release_id[\s\S]*EXPECTED_RELEASE_ID[\s\S]*current_tag_sha[\s\S]*EXPECTED_TAG_SHA/,
    );
    assert.match(
      integrationWorkflow,
      /release_status=\$\(api_status 'releases\/tags\/terraform-state'[\s\S]*test "\$release_status" = 404[\s\S]*test "\$tag_status" = 404/,
    );
  });
});
