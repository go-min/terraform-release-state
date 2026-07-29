import { strict as assert } from "node:assert";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawn } from "node:child_process";

const state = Buffer.from(
  '{"version":4,"terraform_version":"integration","serial":1,"lineage":"release-candidate","resources":[]}\n',
);
const sha256 = createHash("sha256").update(state).digest("hex");
const mutations = [];

const server = createServer((request, response) => {
  const url = new URL(request.url || "/", "http://localhost");
  if (request.method !== "GET") mutations.push(`${request.method} ${url.pathname}`);
  response.setHeader("content-type", "application/json");
  if (
    request.method === "GET" &&
    url.pathname ===
      "/repos/go-min/terraform-release-state/releases/tags/terraform-state"
  ) {
    response.end(
      JSON.stringify({
        id: 1,
        tag_name: "terraform-state",
        body: "operator-owned integration metadata",
      }),
    );
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname ===
      "/repos/go-min/terraform-release-state/releases/1/assets"
  ) {
    response.end(
      JSON.stringify([
        {
          id: 7,
          name: "terraform.tfstate",
          state: "uploaded",
          size: state.length,
          digest: `sha256:${sha256}`,
          created_at: "2026-07-29T10:00:00Z",
          updated_at: "2026-07-29T10:00:00Z",
        },
      ]),
    );
    return;
  }
  if (
    request.method === "GET" &&
    url.pathname ===
      "/repos/go-min/terraform-release-state/releases/assets/7"
  ) {
    response.setHeader("content-type", "application/octet-stream");
    response.end(state);
    return;
  }
  response.statusCode = 404;
  response.end(JSON.stringify({ message: "Not Found" }));
});

await new Promise((resolve, reject) => {
  server.once("error", reject);
  server.listen(0, "127.0.0.1", resolve);
});

const address = server.address();
if (!address || typeof address === "string") throw new Error("missing server port");
const workspace = mkdtempSync(join(tmpdir(), "trs-action-integration-"));
const runnerTemp = mkdtempSync(join(tmpdir(), "trs-runner-integration-"));
const output = join(runnerTemp, "outputs.txt");

try {
  const child = spawn(process.execPath, ["dist/index.js"], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      GITHUB_ACTIONS: "true",
      GITHUB_API_URL: `http://127.0.0.1:${address.port}`,
      GITHUB_REPOSITORY: "go-min/terraform-release-state",
      GITHUB_SHA: "candidate-sha",
      GITHUB_RUN_ID: "candidate-run",
      GITHUB_WORKSPACE: workspace,
      RUNNER_TEMP: runnerTemp,
      GITHUB_OUTPUT: output,
      INPUT_OPERATION: "restore",
      INPUT_GITHUB_TOKEN: "integration-token",
    },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const exitCode = await new Promise((resolve, reject) => {
    child.once("error", reject);
    child.once("close", resolve);
  });
  assert.equal(exitCode, 0, `${stdout}\n${stderr}`);
  assert.deepEqual(readFileSync(join(workspace, "terraform.tfstate")), state);
  const outputs = readFileSync(output, "utf8");
  assert.match(outputs, /operation<<[^\n]+\nrestore\n/);
  assert.match(outputs, /state-sha256<<[^\n]+\n[a-f0-9]{64}\n/);
  assert.match(outputs, /signature-status<<[^\n]+\nunsigned\n/);
  assert.deepEqual(mutations, [], "restore must make no GitHub mutations");
} finally {
  await new Promise((resolve) => server.close(resolve));
  rmSync(workspace, { recursive: true, force: true });
  rmSync(runnerTemp, { recursive: true, force: true });
}
