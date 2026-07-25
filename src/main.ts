import * as github from "@actions/github";
import { createHash } from "node:crypto";
import {
  appendFileSync,
  chmodSync,
  existsSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { resolve } from "node:path";
import {
  parseBoolean,
  parseRepository,
  parseRetention,
  resolveStatePath,
  validateReleaseComponent,
} from "./validation.js";

type Octokit = ReturnType<typeof github.getOctokit>;
type Release = Awaited<
  ReturnType<Octokit["rest"]["repos"]["getReleaseByTag"]>
>["data"];
type Asset = Release["assets"][number];
type Marker = {
  id: number;
  name: string;
  digest: string;
  size: number;
  updatedAt: string;
};

const core = {
  getInput(name: string, options: { required?: boolean } = {}): string {
    const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
    const value = process.env[key] || "";
    if (options.required && !value) fail(`${name} is required.`);
    return value.trim();
  },
  setSecret(value: string): void {
    process.stdout.write(`::add-mask::${value}\n`);
  },
  setOutput(name: string, value: string | number | boolean): void {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      appendFileSync(outputFile, `${name}=${String(value)}\n`);
    } else {
      process.stdout.write(`::set-output name=${name}::${String(value)}\n`);
    }
  },
  setFailed(message: string): void {
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  },
};

const RETRYABLE = new Set([429, 500, 502, 503, 504]);

async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!status || !RETRYABLE.has(status) || attempt >= 4) throw error;
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 500 * 2 ** attempt),
      );
    }
  }
}

function fail(message: string): never {
  throw new Error(message);
}

function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

function digest(asset: Asset): string {
  return ((asset as Asset & { digest?: string }).digest || "").replace(
    /^sha256:/,
    "",
  );
}

function marker(asset: Asset | undefined): string {
  if (!asset) return "absent";
  const value: Marker = {
    id: asset.id,
    name: asset.name,
    digest: digest(asset),
    size: asset.size,
    updatedAt: asset.updated_at,
  };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function decodeMarker(value: string): "absent" | Marker {
  if (value === "absent") return "absent";
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as Marker;
    if (!Number.isInteger(decoded.id) || !decoded.name)
      fail("Invalid expected-remote-state-marker.");
    return decoded;
  } catch {
    fail("Invalid expected-remote-state-marker.");
  }
}

function sameMarker(expected: Marker, actual: Asset): boolean {
  return (
    expected.id === actual.id &&
    expected.name === actual.name &&
    expected.digest === digest(actual) &&
    expected.size === actual.size &&
    expected.updatedAt === actual.updated_at
  );
}

function sameAssetMarker(left: Asset, right: Asset): boolean {
  return marker(left) === marker(right);
}

async function getRelease(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
): Promise<Release | undefined> {
  try {
    const response = (await retry(() =>
      octokit.rest.repos.getReleaseByTag({ owner, repo, tag }),
    )) as { data: Release };
    return response.data;
  } catch (error) {
    if ((error as { status?: number }).status === 404) return undefined;
    throw error;
  }
}

async function createRelease(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
): Promise<Release> {
  const response = (await retry(() =>
    octokit.rest.repos.createRelease({
      owner,
      repo,
      tag_name: tag,
      name: "Terraform state",
      body: "Service release for Terraform state; do not delete.",
      draft: false,
      prerelease: false,
    }),
  )) as { data: Release };
  return response.data;
}

async function assets(
  octokit: Octokit,
  owner: string,
  repo: string,
  releaseId: number,
): Promise<Asset[]> {
  return retry(() =>
    octokit.paginate(octokit.rest.repos.listReleaseAssets, {
      owner,
      repo,
      release_id: releaseId,
      per_page: 100,
    }),
  ) as Promise<Asset[]>;
}

function findAsset(items: Asset[], name: string): Asset | undefined {
  const matches = items.filter(
    (asset) => asset.name === name && asset.state === "uploaded",
  );
  if (matches.length > 1)
    fail(`Release contains duplicate assets named ${name}.`);
  return matches[0];
}

async function download(
  octokit: Octokit,
  owner: string,
  repo: string,
  asset: Asset,
): Promise<Buffer> {
  const response = (await retry(() =>
    octokit.request("GET /repos/{owner}/{repo}/releases/assets/{asset_id}", {
      owner,
      repo,
      asset_id: asset.id,
      headers: { accept: "application/octet-stream" },
      request: { responseType: "arraybuffer" },
    }),
  )) as unknown as { data: ArrayBuffer | Buffer };
  const data = response.data as unknown as ArrayBuffer | Buffer;
  const contents = Buffer.isBuffer(data) ? data : Buffer.from(data);
  if (contents.length === 0) fail(`State asset ${asset.name} is empty.`);
  if (digest(asset) && digest(asset) !== sha256(contents))
    fail(`Integrity check failed for asset ${asset.name}.`);
  return contents;
}

async function upload(
  octokit: Octokit,
  owner: string,
  repo: string,
  releaseId: number,
  name: string,
  data: Buffer,
  contentType = "application/octet-stream",
): Promise<Asset> {
  const response = (await retry(() =>
    octokit.rest.repos.uploadReleaseAsset({
      owner,
      repo,
      release_id: releaseId,
      name,
      data: data as unknown as string,
      headers: { "content-type": contentType, "content-length": data.length },
    }),
  )) as { data: Asset };
  return response.data;
}

async function remove(
  octokit: Octokit,
  owner: string,
  repo: string,
  assetId: number,
): Promise<void> {
  await retry(() =>
    octokit.rest.repos.deleteReleaseAsset({ owner, repo, asset_id: assetId }),
  );
}

function outputs(
  operation: string,
  release: Release,
  asset: Asset | undefined,
  data: Buffer | undefined,
  bootstrapped = false,
): void {
  core.setOutput("operation", operation);
  core.setOutput("release-id", release.id);
  core.setOutput("bootstrapped", bootstrapped);
  core.setOutput("remote-state-marker", marker(asset));
  if (asset) {
    core.setOutput("state-asset-id", asset.id);
    core.setOutput("state-digest", digest(asset));
  }
  if (data) core.setOutput("state-sha256", sha256(data));
}

async function restore(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
  name: string,
  path: string,
  allowBootstrap: boolean,
): Promise<void> {
  let release = await getRelease(octokit, owner, repo, tag);
  if (!release) {
    if (!allowBootstrap)
      fail(
        `State release ${tag} does not exist; set bootstrap=true explicitly.`,
      );
    release = await createRelease(octokit, owner, repo, tag);
  }
  const asset = findAsset(await assets(octokit, owner, repo, release.id), name);
  if (!asset) {
    if (!allowBootstrap)
      fail(`State asset ${name} is missing from release ${tag}.`);
    if (existsSync(path))
      fail(`State asset is missing but local state already exists at ${path}.`);
    core.setOutput("operation", "restore");
    core.setOutput("release-id", release.id);
    core.setOutput("bootstrapped", true);
    core.setOutput("remote-state-marker", "absent");
    return;
  }
  const data = await download(octokit, owner, repo, asset);
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
  outputs("restore", release, asset, data);
}

async function save(
  octokit: Octokit,
  owner: string,
  repo: string,
  tag: string,
  name: string,
  path: string,
  allowBootstrap: boolean,
  expectedValue: string,
  keep: number,
  sourceCommit: string,
  runId: string,
): Promise<void> {
  if (!existsSync(path)) fail(`State file not found: ${path}`);
  const data = readFileSync(path);
  if (!data.length) fail(`State file is empty: ${path}`);
  const expected = expectedValue ? decodeMarker(expectedValue) : undefined;
  let release = await getRelease(octokit, owner, repo, tag);
  if (!release) {
    if (!allowBootstrap)
      fail(
        `State release ${tag} does not exist; set bootstrap=true explicitly.`,
      );
    release = await createRelease(octokit, owner, repo, tag);
  }
  let allAssets = await assets(octokit, owner, repo, release.id);
  let current = findAsset(allAssets, name);
  let bootstrapped = false;
  if (!expected && current)
    fail(
      "save requires expected-remote-state-marker from restore when current state exists.",
    );
  if (expected === "absent" && current)
    fail("Remote state appeared after restore; refusing to overwrite it.");
  if (
    expected &&
    expected !== "absent" &&
    (!current || !sameMarker(expected, current))
  )
    fail("Remote state changed after restore; refusing to overwrite it.");
  if (!current && expected && expected !== "absent")
    fail("Remote state disappeared after restore; refusing to recreate it.");
  if (!current && !allowBootstrap && expected !== "absent")
    fail("Current state is missing; refusing implicit bootstrap.");
  bootstrapped = !current && allowBootstrap;

  let previous: Buffer | undefined;
  let backupName = "";
  if (current) {
    previous = await download(octokit, owner, repo, current);
    const timestamp = new Date()
      .toISOString()
      .replace(/[-:]/g, "")
      .replace(/\.\d{3}Z$/, "Z");
    backupName = `${name}.backup-${timestamp}-${process.env.GITHUB_RUN_ID || "local"}`;
    const metadata = Buffer.from(
      `${JSON.stringify({ timestamp_utc: new Date().toISOString(), source_commit: sourceCommit || process.env.GITHUB_SHA || "unknown", workflow_run_id: runId || process.env.GITHUB_RUN_ID || "unknown", action_version: process.env.GITHUB_ACTION_REF || "unknown", current_asset: name, sha256: sha256(previous) }, null, 2)}\n`,
    );
    await upload(octokit, owner, repo, release.id, backupName, previous);
    await upload(
      octokit,
      owner,
      repo,
      release.id,
      `${backupName}.metadata.json`,
      metadata,
      "application/json",
    );
  }
  const latest = findAsset(
    await assets(octokit, owner, repo, release.id),
    name,
  );
  if (current && (!latest || !sameAssetMarker(current, latest)))
    fail("Remote state changed during save; refusing to overwrite it.");
  if (!current && latest)
    fail("Remote state appeared during save; refusing to overwrite it.");
  current = latest;
  if (current) await remove(octokit, owner, repo, current.id);
  try {
    await upload(octokit, owner, repo, release.id, name, data);
  } catch (error) {
    const failed = findAsset(
      await assets(octokit, owner, repo, release.id),
      name,
    );
    if (failed) await remove(octokit, owner, repo, failed.id);
    if (previous)
      await upload(octokit, owner, repo, release.id, name, previous);
    throw error;
  }
  allAssets = await assets(octokit, owner, repo, release.id);
  current = findAsset(allAssets, name);
  if (!current) fail(`Uploaded state asset ${name} could not be found.`);
  const uploaded = await download(octokit, owner, repo, current);
  if (sha256(uploaded) !== sha256(data))
    fail(`Uploaded state asset ${name} failed checksum verification.`);
  const backups = allAssets
    .filter(
      (asset) =>
        asset.name.startsWith(`${name}.backup-`) && asset.state === "uploaded",
    )
    .sort((a, b) => Date.parse(b.created_at) - Date.parse(a.created_at));
  for (const backup of backups.slice(keep)) {
    await remove(octokit, owner, repo, backup.id);
    const metadata = findAsset(allAssets, `${backup.name}.metadata.json`);
    if (metadata) await remove(octokit, owner, repo, metadata.id);
  }
  outputs("save", release, current, data, bootstrapped);
  core.setOutput("backup-asset-name", backupName);
  core.setOutput("backup-count", Math.min(backups.length, keep));
}

async function run(): Promise<void> {
  const token = core.getInput("github-token", { required: true });
  core.setSecret(token);
  const operation = core
    .getInput("operation", { required: true })
    .toLowerCase();
  if (operation !== "restore" && operation !== "save")
    fail("operation must be restore or save.");
  const target = parseRepository(
    core.getInput("state-repository") || process.env.GITHUB_REPOSITORY || "",
  );
  const tag = core.getInput("release-tag");
  const name = core.getInput("state-asset");
  if (
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(tag) ||
    !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)
  )
    fail("release-tag and state-asset contain unsupported characters.");
  validateReleaseComponent(tag, "release-tag");
  validateReleaseComponent(name, "state-asset");
  const path = resolveStatePath(
    core.getInput("state-path", { required: true }),
    resolve(process.env.GITHUB_WORKSPACE || process.cwd()),
  );
  const allowBootstrap = parseBoolean(core.getInput("bootstrap"), "bootstrap");
  const keep = parseRetention(core.getInput("backup-retention"));
  const octokit = github.getOctokit(token);
  if (operation === "restore") {
    await restore(
      octokit,
      target.owner,
      target.repo,
      tag,
      name,
      path,
      allowBootstrap,
    );
  } else {
    await save(
      octokit,
      target.owner,
      target.repo,
      tag,
      name,
      path,
      allowBootstrap,
      core.getInput("expected-remote-state-marker"),
      keep,
      core.getInput("source-commit"),
      core.getInput("workflow-run-id"),
    );
  }
}

run().catch((error) =>
  core.setFailed(
    error instanceof Error ? error.message : "Terraform Release State failed.",
  ),
);
