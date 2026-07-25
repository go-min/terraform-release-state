import { isAbsolute, relative, resolve, sep } from "node:path";

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
  throw new Error(`${name} must be true or false.`);
}

export function parseRetention(value: string): number {
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed < 0 || parsed > 1000) {
    throw new Error("backup-retention must be an integer from 0 through 1000.");
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
    throw new Error("state-repository must use the owner/name format.");
  }
  return { owner: parts[0], repo: parts[1] };
}

export function resolveStatePath(value: string, workspace: string): string {
  if (!value || value.includes("\0"))
    throw new Error("state-path must be a non-empty path.");
  const absolute = resolve(workspace, value);
  if (!isPathInside(workspace, absolute)) {
    throw new Error("state-path must remain inside GITHUB_WORKSPACE.");
  }
  return absolute;
}

export function validateReleaseComponent(value: string, name: string): void {
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value))
    throw new Error(`${name} contains unsupported characters.`);
}
