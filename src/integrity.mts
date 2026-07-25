import { createHash } from "node:crypto";
import type { Asset } from "./types.mjs";

export function sha256(data: Buffer): string {
  return createHash("sha256").update(data).digest("hex");
}

export function assetDigest(asset: Asset): string {
  return ((asset as Asset & { digest?: string }).digest || "").replace(
    /^sha256:/,
    "",
  );
}
