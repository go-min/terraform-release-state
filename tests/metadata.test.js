const fs = require("node:fs");
const { describe, it } = require("node:test");
const assert = require("node:assert/strict");

describe("action metadata", () => {
  const metadata = fs.readFileSync("action.yml", "utf8");

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
