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

const RETRYABLE_STATUSES = new Set([429, 500, 502, 503, 504]);

export async function retry<T>(operation: () => Promise<T>): Promise<T> {
  for (let attempt = 0; ; attempt += 1) {
    try {
      return await operation();
    } catch (error) {
      const status = (error as { status?: number }).status;
      if (!status || !RETRYABLE_STATUSES.has(status) || attempt >= 4) {
        throw error;
      }
      await new Promise((resolveDelay) =>
        setTimeout(resolveDelay, 500 * 2 ** attempt),
      );
    }
  }
}
