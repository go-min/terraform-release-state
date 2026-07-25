const fs = require("node:fs");

describe("action metadata", () => {
  const metadata = fs.readFileSync("action.yml", "utf8");

  test("uses the Node 24 runtime and compiled bundle", () => {
    expect(metadata).toContain("using: node24");
    expect(metadata).toContain("main: dist/index.js");
  });

  test("exposes the stable restore/save API", () => {
    expect(metadata).toContain("operation:");
    expect(metadata).toContain("expected-remote-state-marker:");
    expect(metadata).toContain("backup-retention:");
    expect(metadata).toContain("remote-state-marker:");
  });
});
