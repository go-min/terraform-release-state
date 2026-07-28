import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { failWithCode } from "./errors.mjs";

export function fail(message: string): never {
  failWithCode("TRS_CONFIG_INVALID", message);
}

function commandValue(value: string): string {
  return value
    .replaceAll("%", "%25")
    .replaceAll("\r", "%0D")
    .replaceAll("\n", "%0A");
}

export const core = {
  info(message: string): void {
    process.stdout.write(`${message}\n`);
  },

  warning(message: string): void {
    process.stdout.write(`::warning::${commandValue(message)}\n`);
  },

  getInput(name: string, options: { required?: boolean } = {}): string {
    const key = `INPUT_${name.replace(/ /g, "_").toUpperCase()}`;
    const shellSafeKey = key.replaceAll("-", "_");
    const value = process.env[key] || process.env[shellSafeKey] || "";
    if (options.required && !value) fail(`${name} is required.`);
    return value.trim();
  },

  setSecret(value: string): void {
    for (const line of value.split(/\r?\n/)) {
      const secret = line.trim();
      if (secret) process.stdout.write(`::add-mask::${commandValue(secret)}\n`);
    }
  },

  setOutput(name: string, value: string | number | boolean): void {
    const outputFile = process.env.GITHUB_OUTPUT;
    if (outputFile) {
      const text = String(value);
      let delimiter = `ghadelimiter_${randomUUID()}`;
      while (text.includes(delimiter)) {
        delimiter = `ghadelimiter_${randomUUID()}`;
      }
      appendFileSync(
        outputFile,
        `${name}<<${delimiter}\n${text}\n${delimiter}\n`,
      );
      return;
    }
    if (process.env.GITHUB_ACTIONS === "true") {
      fail("GITHUB_OUTPUT is unavailable; refusing deprecated output syntax.");
    }
  },

  setFailed(message: string): void {
    process.stderr.write(`::error::${commandValue(message)}\n`);
    process.exitCode = 1;
  },
};
