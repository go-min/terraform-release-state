import { isAbsolute, relative, resolve, sep } from "node:path";
import { failWithCode } from "./errors.mjs";

function fail(message: string): never {
  failWithCode("TRS_CONFIG_INVALID", message);
}

export function isPathInside(root: string, candidate: string): boolean {
  const relativePath = relative(root, candidate);
  return (
    relativePath === "" ||
    (relativePath !== ".." &&
      !relativePath.startsWith(`..${sep}`) &&
      !isAbsolute(relativePath))
  );
}

export function parseBoolean(value: string, name: string): boolean {
  if (value === "true") return true;
  if (value === "false" || value === "") return false;
  fail(`${name} must be true or false.`);
}

export function parseRetention(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    fail("backup-retention must be an integer from 0 through 1000.");
  }
  return parsed;
}

export function parseRepository(value: string): {
  owner: string;
  repo: string;
} {
  const parts = value.split("/");
  if (
    parts.length !== 2 ||
    parts.some((part) => !/^[A-Za-z0-9_.-]+$/.test(part))
  ) {
    fail("state-repository must use the owner/name format.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export function resolveStatePath(value: string, workspace: string): string {
  return resolveWorkspacePath(value, "state-path", workspace);
}

export function resolveWorkspacePath(
  value: string,
  name: string,
  workspace: string,
): string {
  if (!value || value.includes("\0")) fail(`${name} must be a non-empty path.`);
  const absolute = resolve(workspace, value);
  if (!isPathInside(workspace, absolute)) {
    fail(`${name} must remain inside GITHUB_WORKSPACE.`);
  }
  return absolute;
}

export function validateReleaseComponent(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
    fail(`${name} contains unsupported characters.`);
}

export function validateGitRef(value: string, name: string): void {
  if (
    !value ||
    value.startsWith("/") ||
    value.endsWith("/") ||
    value.startsWith(".") ||
    value.endsWith(".") ||
    value.includes("..") ||
    value.includes("@{") ||
    [...value].some((character) => "\0 ~^:?*[]\\".includes(character))
  ) {
    fail(`${name} contains unsupported Git ref characters.`);
  }
}
