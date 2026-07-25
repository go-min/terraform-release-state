import * as github from "@actions/github";
import { core } from "./action-core.mjs";
import { readConfig } from "./config.mjs";
import { restore, save } from "./state-manager.mjs";

async function run(): Promise<void> {
  const config = readConfig();
  const context = { octokit: github.getOctokit(config.token), config };
  if (config.operation === "restore") {
    await restore(context);
    return;
  }
  await save(context);
}

run().catch((error) =>
  core.setFailed(
    error instanceof Error ? error.message : "Terraform Release State failed.",
  ),
);
