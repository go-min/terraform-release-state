const { readFileSync } = require("node:fs");
const { strict: assert } = require("node:assert");
const { describe, it } = require("node:test");

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
  });
});
