import { randomUUID } from "node:crypto";

export function backupName(assetName: string, runId: string): string {
  const timestamp = new Date()
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.([0-9]{3})Z$/, "$1Z");
  return `${assetName}.backup-${timestamp}-${runId || process.env.GITHUB_RUN_ID || "local"}-${randomUUID()}`;
}
