import { existsSync, readFileSync } from "node:fs";
import { relative } from "node:path";
import { core, fail } from "./action-core.mjs";
import { prepareImportPullRequest } from "./import-pr.mjs";
import { readStoredState } from "./state-manager.mjs";
import type { StateManagerContext } from "./types.mjs";

type ImportCandidate = { address: string; id: string };
type SkippedResource = { address: string; reason: string };

type TerraformState = {
  resources?: unknown;
};

type ResourceAttributes = Record<string, unknown>;

function quote(value: string): string {
  return JSON.stringify(value);
}

function instanceSuffix(index: unknown): string {
  if (typeof index === "number" && Number.isInteger(index)) {
    return `[${index}]`;
  }
  if (typeof index === "string") return `[${quote(index)}]`;
  return "";
}

function resourceAddress(resource: Record<string, unknown>): string {
  if (typeof resource.address === "string" && resource.address) {
    return resource.address;
  }
  const type = resource.type;
  const name = resource.name;
  if (typeof type !== "string" || typeof name !== "string") return "";
  const module = typeof resource.module === "string" ? resource.module : "";
  return `${module ? `${module}.` : ""}${type}.${name}`;
}

function normalizeImportId(
  resourceType: unknown,
  attributes: ResourceAttributes,
  id: string,
): { id?: string; reason?: string } {
  const repository =
    typeof attributes.repository === "string"
      ? attributes.repository.trim()
      : "";

  if (resourceType === "github_repository_ruleset") {
    if (!repository) {
      return {
        reason:
          "missing non-empty attributes.repository required for github_repository_ruleset import ID",
      };
    }
    return {
      id: id.startsWith(`${repository}:`) ? id : `${repository}:${id}`,
    };
  }

  if (resourceType === "github_repository_vulnerability_alerts") {
    if (!repository) {
      return {
        reason:
          "missing non-empty attributes.repository required for github_repository_vulnerability_alerts import ID",
      };
    }
    return { id: repository };
  }

  return { id };
}

export function candidatesFromState(state: TerraformState): {
  candidates: ImportCandidate[];
  skipped: SkippedResource[];
} {
  if (!Array.isArray(state.resources)) {
    fail("Stored state does not contain a Terraform resources array.");
  }
  const candidates: ImportCandidate[] = [];
  const skipped: SkippedResource[] = [];
  for (const value of state.resources) {
    if (!value || typeof value !== "object") {
      skipped.push({ address: "<unknown>", reason: "invalid resource entry" });
      continue;
    }
    const resource = value as Record<string, unknown>;
    const baseAddress = resourceAddress(resource);
    if (!baseAddress) {
      skipped.push({
        address: "<unknown>",
        reason: "missing resource address",
      });
      continue;
    }
    if (resource.mode !== "managed") {
      skipped.push({ address: baseAddress, reason: "not a managed resource" });
      continue;
    }
    if (!Array.isArray(resource.instances)) {
      skipped.push({
        address: baseAddress,
        reason: "missing resource instances",
      });
      continue;
    }
    for (const instanceValue of resource.instances) {
      if (!instanceValue || typeof instanceValue !== "object") {
        skipped.push({
          address: baseAddress,
          reason: "invalid resource instance",
        });
        continue;
      }
      const instance = instanceValue as Record<string, unknown>;
      const address = `${baseAddress}${instanceSuffix(instance.index_key)}`;
      const attributes =
        instance.attributes && typeof instance.attributes === "object"
          ? (instance.attributes as ResourceAttributes)
          : {};
      const id = attributes.id;
      if (typeof id !== "string" && typeof id !== "number") {
        skipped.push({
          address,
          reason: "missing string or numeric attributes.id",
        });
        continue;
      }
      if (!String(id)) {
        skipped.push({ address, reason: "empty attributes.id" });
        continue;
      }
      const normalized = normalizeImportId(
        resource.type,
        attributes,
        String(id),
      );
      if (!normalized.id) {
        skipped.push({
          address,
          reason: normalized.reason || "invalid import ID",
        });
        continue;
      }
      candidates.push({ address, id: normalized.id });
    }
  }
  const byAddress = new Map<string, ImportCandidate | null>();
  const unambiguous: ImportCandidate[] = [];
  for (const candidate of candidates) {
    const previous = byAddress.get(candidate.address);
    if (previous === null) continue;
    if (previous && previous.id !== candidate.id) {
      skipped.push({ address: candidate.address, reason: "conflicting IDs" });
      const index = unambiguous.findIndex(
        (item) => item.address === candidate.address,
      );
      if (index >= 0) unambiguous.splice(index, 1);
      byAddress.set(candidate.address, null);
      continue;
    }
    if (!previous) {
      byAddress.set(candidate.address, candidate);
      unambiguous.push(candidate);
    }
  }
  unambiguous.sort((left, right) => left.address.localeCompare(right.address));
  return { candidates: unambiguous, skipped };
}

export function renderImports(candidates: ImportCandidate[]): string {
  const lines = [
    "# This file was generated from Terraform state stored in GitHub Release assets.",
    "# Review every import target and the resulting Terraform plan before applying.",
    "# Provider-specific import IDs are copied from Terraform state.",
    "",
  ];
  for (const candidate of candidates) {
    lines.push(
      "import {",
      `  to = ${candidate.address}`,
      `  id = ${quote(candidate.id)}`,
      "}",
      "",
    );
  }
  return `${lines.join("\n").trimEnd()}\n`;
}

function diffLines(current: string, generated: string, path: string): string {
  const before = current ? current.split(/\r?\n/) : [];
  const after = generated.split(/\r?\n/);
  const rows: string[] = [`--- a/${path}`, `+++ b/${path}`];
  let left = 0;
  let right = 0;
  while (left < before.length || right < after.length) {
    if (before[left] === after[right]) {
      rows.push(` ${before[left]}`);
      left += 1;
      right += 1;
    } else if (
      right < after.length &&
      !before.slice(left + 1).includes(after[right])
    ) {
      rows.push(`+${after[right]}`);
      right += 1;
    } else {
      rows.push(`-${before[left]}`);
      left += 1;
    }
  }
  return rows.join("\n");
}

export async function generateImports(
  context: StateManagerContext,
): Promise<void> {
  const { config } = context;
  const rawState = await readStoredState(context);
  let state: TerraformState;
  try {
    state = JSON.parse(rawState.toString("utf8")) as TerraformState;
  } catch {
    fail("Stored state is not valid JSON Terraform state.");
  }
  const { candidates, skipped } = candidatesFromState(state);
  const generated = renderImports(candidates);
  const outputPath = config.importsPath;
  const relativePath = relative(config.workspace, outputPath);
  const repositoryPath = relativePath.replaceAll("\\", "/");
  let current = existsSync(outputPath) ? readFileSync(outputPath, "utf8") : "";
  let pullRequestUrl: string | undefined;
  if (config.createPr) {
    const result = await prepareImportPullRequest(
      context,
      repositoryPath,
      Buffer.from(generated),
      candidates.length,
      skipped.length,
    );
    current = result.baseContent.toString("utf8");
    pullRequestUrl = result.url;
  }
  core.info(
    `Import proposals: ${candidates.length} candidate(s), ${skipped.length} skipped; output ${relativePath}`,
  );
  for (const item of skipped) {
    core.info(`Import proposals: skipped ${item.address} (${item.reason}).`);
  }
  if (current === generated) {
    core.info("Import proposals: imports file is unchanged; no diff.");
    return;
  }
  core.info(
    config.createPr
      ? "Import proposals: proposed diff (workspace file was not modified; PR branch may be updated):"
      : "Import proposals: proposed diff (file was not modified):",
  );
  core.info(diffLines(current, generated, relativePath));
  if (pullRequestUrl) core.setOutput("import-pr-url", pullRequestUrl);
}
