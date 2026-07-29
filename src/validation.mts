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
