import { appendFileSync } from "node:fs";

export function fail(message: string): never {
  throw new Error(message);
}

export const core = {
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
      return;
    }
    process.stdout.write(`::set-output name=${name}::${String(value)}\n`);
  },

  setFailed(message: string): void {
    process.stderr.write(`::error::${message}\n`);
    process.exitCode = 1;
  },
};
