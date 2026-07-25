import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { basename, dirname, join, relative, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { isPathInside } from "./validation.mjs";

function fail(message: string): never {
  throw new Error(message);
}

function stateDirectory(path: string, workspace: string): string {
  const workspacePath = resolve(workspace);
  const pathRelative = relative(workspacePath, path);
  if (!isPathInside(workspacePath, path)) {
    fail("state-path must remain inside GITHUB_WORKSPACE.");
  }

  const root = realpathSync(workspacePath);
  const components = pathRelative.split(/[\\/]/).slice(0, -1);
  let current = root;
  for (const component of components) {
    if (!component || component === ".") continue;
    const candidate = join(current, component);
    if (!existsSync(candidate)) mkdirSync(candidate, { mode: 0o700 });
    const info = lstatSync(candidate);
    if (info.isSymbolicLink() || !info.isDirectory()) {
      fail(
        "state-path must not traverse symbolic links or non-directory components.",
      );
    }
    current = realpathSync(candidate);
    if (!isPathInside(root, current)) {
      fail("state-path must remain inside GITHUB_WORKSPACE.");
    }
  }
  return current;
}

function stateFile(path: string, workspace: string): string {
  const directory = stateDirectory(path, workspace);
  const file = join(directory, basename(path));
  if (existsSync(file)) {
    const info = lstatSync(file);
    if (info.isSymbolicLink() || !info.isFile()) {
      fail("state-path must reference a regular file, not a symbolic link.");
    }
  }
  return file;
}

export function readStateFile(path: string, workspace: string): Buffer {
  return readFileSync(stateFile(path, workspace));
}

export function writeStateFile(
  path: string,
  workspace: string,
  data: Buffer,
): void {
  const file = stateFile(path, workspace);
  const temporary = join(
    dirname(file),
    `.${basename(file)}.${randomUUID()}.tmp`,
  );
  try {
    writeFileSync(temporary, data, { mode: 0o600, flag: "wx" });
    chmodSync(temporary, 0o600);
    renameSync(temporary, file);
    chmodSync(file, 0o600);
  } finally {
    rmSync(temporary, { force: true });
  }
}
