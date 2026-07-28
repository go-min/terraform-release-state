import { readFileSync } from "node:fs";
import { strict as assert } from "node:assert";
import { describe, it } from "node:test";

const metadata = readFileSync("action.yml", "utf8");

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
  });
});
