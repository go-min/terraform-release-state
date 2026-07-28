import {
  lstatSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
} from "node:fs";
import { join, relative, resolve } from "node:path";
import { isPathInside } from "./validation.mjs";

type Token = {
  kind: "atom" | "newline" | "string" | "symbol";
  line: number;
  value: string;
};

export type ImportTarget = {
  address: string;
  locations: string[];
};

type FileSystemError = Error & { code?: string };

function checkedRealPath(
  workspace: string,
  candidate: string,
  name: string,
): { path: string; realPath: string } {
  const workspacePath = resolve(workspace);
  const path = resolve(candidate);
  if (!isPathInside(workspacePath, path)) {
    throw new Error(`${name} must remain inside GITHUB_WORKSPACE.`);
  }
  const realWorkspace = realpathSync(workspacePath);
  const realPath = realpathSync(path);
  if (!isPathInside(realWorkspace, realPath)) {
    throw new Error(`${name} resolves outside GITHUB_WORKSPACE.`);
  }
  const expectedRealPath = resolve(
    realWorkspace,
    relative(workspacePath, path),
  );
  if (relative(expectedRealPath, realPath) !== "") {
    throw new Error(`${name} must not traverse symbolic links.`);
  }
  return { path, realPath };
}

export function readLocalImportsFile(
  workspace: string,
  importsPath: string,
): string {
  const workspacePath = resolve(workspace);
  const path = resolve(importsPath);
  if (!isPathInside(workspacePath, path)) {
    throw new Error("imports-path must remain inside GITHUB_WORKSPACE.");
  }
  let status: ReturnType<typeof lstatSync>;
  try {
    status = lstatSync(path);
  } catch (error) {
    if ((error as FileSystemError).code === "ENOENT") return "";
    throw error;
  }
  if (status.isSymbolicLink()) {
    throw new Error("imports-path must not be a symbolic link.");
  }
  if (!status.isFile()) {
    throw new Error("imports-path must be a regular file when it exists.");
  }
  const checked = checkedRealPath(workspace, path, "imports-path");
  return readFileSync(checked.realPath, "utf8");
}

function parseError(source: string, line: number, message: string): never {
  throw new Error(
    `Cannot inspect Terraform import targets in ${source}:${line}: ${message}`,
  );
}

function quotedToken(
  text: string,
  start: number,
  source: string,
  line: number,
) {
  let index = start + 1;
  let escaped = false;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n" || character === "\r") {
      parseError(source, line, "unterminated quoted string");
    }
    if (!escaped && character === '"') {
      const raw = text.slice(start, index + 1);
      let value = raw;
      if (!raw.includes("${") && !raw.includes("%{")) {
        try {
          value = JSON.stringify(JSON.parse(raw));
        } catch {
          parseError(source, line, "invalid quoted string escape");
        }
      }
      return { index: index + 1, value };
    }
    if (!escaped && character === "\\") escaped = true;
    else escaped = false;
    index += 1;
  }
  parseError(source, line, "unterminated quoted string");
}

function heredocEnd(
  text: string,
  start: number,
  source: string,
  line: number,
): { index: number; line: number } {
  const headerEnd = text.indexOf("\n", start);
  if (headerEnd < 0) parseError(source, line, "unterminated heredoc header");
  const header = text.slice(start + 2, headerEnd).trim();
  const indented = header.startsWith("-");
  const marker = (indented ? header.slice(1) : header).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(marker)) {
    parseError(source, line, "unsupported heredoc marker");
  }

  let index = headerEnd + 1;
  let currentLine = line + 1;
  while (index <= text.length) {
    const end = text.indexOf("\n", index);
    const lineEnd = end < 0 ? text.length : end;
    const value = text.slice(index, lineEnd).replace(/\r$/, "");
    if ((indented ? value.trimStart() : value) === marker) {
      return {
        index: end < 0 ? text.length : end + 1,
        line: currentLine + (end < 0 ? 0 : 1),
      };
    }
    if (end < 0) break;
    index = end + 1;
    currentLine += 1;
  }
  parseError(source, line, `unterminated heredoc ${marker}`);
}

function tokenize(text: string, source: string): Token[] {
  const tokens: Token[] = [];
  let index = 0;
  let line = 1;
  while (index < text.length) {
    const character = text[index];
    if (character === "\n") {
      tokens.push({ kind: "newline", line, value: "\n" });
      index += 1;
      line += 1;
      continue;
    }
    if (character === "\r" || character === " " || character === "\t") {
      index += 1;
      continue;
    }
    if (character === "#" || text.startsWith("//", index)) {
      const end = text.indexOf("\n", index);
      index = end < 0 ? text.length : end;
      continue;
    }
    if (text.startsWith("/*", index)) {
      const end = text.indexOf("*/", index + 2);
      if (end < 0) parseError(source, line, "unterminated block comment");
      const comment = text.slice(index, end + 2);
      line += comment.split("\n").length - 1;
      index = end + 2;
      continue;
    }
    if (character === '"') {
      const token = quotedToken(text, index, source, line);
      tokens.push({ kind: "string", line, value: token.value });
      index = token.index;
      continue;
    }
    if (text.startsWith("<<", index)) {
      const heredoc = heredocEnd(text, index, source, line);
      tokens.push({ kind: "string", line, value: "<heredoc>" });
      index = heredoc.index;
      line = heredoc.line;
      continue;
    }
    if (/[A-Za-z0-9_-]/.test(character)) {
      const start = index;
      while (index < text.length && /[A-Za-z0-9_-]/.test(text[index])) {
        index += 1;
      }
      tokens.push({ kind: "atom", line, value: text.slice(start, index) });
      continue;
    }
    tokens.push({ kind: "symbol", line, value: character });
    index += 1;
  }
  return tokens;
}

function nextNonNewline(tokens: Token[], start: number): number {
  let index = start;
  while (tokens[index]?.kind === "newline") index += 1;
  return index;
}

function matchingBrace(
  tokens: Token[],
  opening: number,
  source: string,
): number {
  let depth = 0;
  for (let index = opening; index < tokens.length; index += 1) {
    if (tokens[index].value === "{") depth += 1;
    if (tokens[index].value === "}") depth -= 1;
    if (depth === 0) return index;
  }
  parseError(source, tokens[opening].line, "unterminated import block");
}

function canonicalExpression(
  tokens: Token[],
  source: string,
  line: number,
): string {
  const significant = tokens.filter((token) => token.kind !== "newline");
  if (significant.length === 0) {
    parseError(source, line, "import to attribute has no expression");
  }
  if (significant.some((token) => token.value === "<heredoc>")) {
    parseError(source, line, "import to attribute cannot use a heredoc");
  }
  return significant.map((token) => token.value).join("");
}

function targetsFromTokens(tokens: Token[], source: string): ImportTarget[] {
  const targets: ImportTarget[] = [];
  let depth = 0;
  for (let index = 0; index < tokens.length; index += 1) {
    const token = tokens[index];
    if (token.value === "{") {
      depth += 1;
      continue;
    }
    if (token.value === "}") {
      depth -= 1;
      if (depth < 0) parseError(source, token.line, "unexpected closing brace");
      continue;
    }
    if (depth !== 0 || token.kind !== "atom" || token.value !== "import") {
      continue;
    }
    const opening = nextNonNewline(tokens, index + 1);
    if (tokens[opening]?.value !== "{") continue;
    const closing = matchingBrace(tokens, opening, source);
    let target: ImportTarget | undefined;
    let nested = 0;
    for (let cursor = opening + 1; cursor < closing; cursor += 1) {
      const current = tokens[cursor];
      if (
        current.value === "{" ||
        current.value === "[" ||
        current.value === "("
      ) {
        nested += 1;
        continue;
      }
      if (
        current.value === "}" ||
        current.value === "]" ||
        current.value === ")"
      ) {
        nested -= 1;
        continue;
      }
      if (nested !== 0 || current.kind !== "atom" || current.value !== "to") {
        continue;
      }
      const equals = nextNonNewline(tokens, cursor + 1);
      if (tokens[equals]?.value !== "=") continue;
      if (target)
        parseError(source, current.line, "duplicate import to attribute");
      const expression: Token[] = [];
      let expressionDepth = 0;
      let end = equals + 1;
      for (; end < closing; end += 1) {
        const expressionToken = tokens[end];
        if (expressionToken.kind === "newline" && expressionDepth === 0) break;
        if (
          expressionToken.value === "{" ||
          expressionToken.value === "[" ||
          expressionToken.value === "("
        ) {
          expressionDepth += 1;
        } else if (
          expressionToken.value === "}" ||
          expressionToken.value === "]" ||
          expressionToken.value === ")"
        ) {
          expressionDepth -= 1;
          if (expressionDepth < 0) break;
        }
        expression.push(expressionToken);
      }
      target = {
        address: canonicalExpression(expression, source, current.line),
        locations: [`${source}:${current.line}`],
      };
      cursor = end;
    }
    if (!target)
      parseError(source, token.line, "import block has no to attribute");
    targets.push(target);
    index = closing;
  }
  if (depth !== 0)
    parseError(source, tokens.at(-1)?.line || 1, "unbalanced braces");
  return targets;
}

export function canonicalImportTarget(address: string): string {
  return canonicalExpression(
    tokenize(address, "generated import address"),
    "generated import address",
    1,
  );
}

function terraformFiles(root: string, excludedPath: string): string[] {
  const files: string[] = [];
  const excludedDirectories = new Set([".git", ".terraform", "node_modules"]);
  function visit(directory: string): void {
    for (const entry of readdirSync(directory, { withFileTypes: true }).sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const path = join(directory, entry.name);
      if (resolve(path) === excludedPath) continue;
      if (excludedDirectories.has(entry.name)) continue;
      if (entry.isSymbolicLink()) {
        if (entry.name.endsWith(".tf") || statSync(path).isDirectory()) {
          throw new Error(
            `Cannot inspect Terraform import targets through symbolic link ${path}.`,
          );
        }
        continue;
      }
      if (entry.isDirectory()) {
        visit(path);
        continue;
      }
      if (entry.isFile() && entry.name.endsWith(".tf")) files.push(path);
    }
  }
  visit(root);
  return files;
}

export function existingImportTargets(
  workspace: string,
  terraformRoot: string,
  generatedPath: string,
): Map<string, ImportTarget> {
  const rootStatus = lstatSync(terraformRoot);
  if (rootStatus.isSymbolicLink()) {
    throw new Error("terraform-root must not be a symbolic link.");
  }
  if (!rootStatus.isDirectory()) {
    throw new Error(`terraform-root is not a directory: ${terraformRoot}`);
  }
  const checkedRoot = checkedRealPath(
    workspace,
    terraformRoot,
    "terraform-root",
  );
  const resolvedGeneratedPath = resolve(generatedPath);
  const excludedPath = isPathInside(checkedRoot.path, resolvedGeneratedPath)
    ? resolve(
        checkedRoot.realPath,
        relative(checkedRoot.path, resolvedGeneratedPath),
      )
    : resolvedGeneratedPath;
  const targets = new Map<string, ImportTarget>();
  for (const path of terraformFiles(checkedRoot.realPath, excludedPath)) {
    const source = relative(checkedRoot.realPath, path).replaceAll("\\", "/");
    for (const target of targetsFromTokens(
      tokenize(readFileSync(path, "utf8"), source),
      source,
    )) {
      const existing = targets.get(target.address);
      if (existing) existing.locations.push(...target.locations);
      else targets.set(target.address, target);
    }
  }
  return targets;
}
