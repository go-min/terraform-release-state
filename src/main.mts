import * as github from "@actions/github";
import { core } from "./action-core.mjs";
import { readConfig } from "./config.mjs";
import { restore, save } from "./state-manager.mjs";
import { reset } from "./reset.mjs";
import { generateImports } from "./imports.mjs";
import { displayError, normalizeActionError } from "./errors.mjs";

async function run(): Promise<void> {
  const config = readConfig();
  const context = { octokit: github.getOctokit(config.token), config };
  if (config.operation === "restore") {
    await restore(context);
    return;
  }
  if (config.operation === "reset") {
    const result = await reset(context);
    core.setOutput("operation", "reset");
    core.setOutput("reset-deleted-asset-count", result.deletedAssetCount);
    core.setOutput("reset-release-found", result.releaseFound);
    return;
  }
  if (config.operation === "import") {
    await generateImports(context);
    return;
  }
  await save(context);
}

run().catch((error) => {
  const actionError = normalizeActionError(error);
  core.setOutput("error-code", actionError.code);
  core.setFailed(displayError(actionError));
});
