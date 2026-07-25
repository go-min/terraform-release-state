import { chmodSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

export function writeStateFile(path: string, data: Buffer): void {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, data, { mode: 0o600 });
  chmodSync(path, 0o600);
}
