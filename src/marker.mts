import { assetDigest } from "./integrity.mjs";
import { failWithCode } from "./errors.mjs";
import type { Asset, DecodedMarker, RemoteStateMarker } from "./types.mjs";

function fail(message: string): never {
  failWithCode("TRS_CONFIG_INVALID", message);
}

export function marker(asset: Asset | undefined): string {
  if (!asset) return "absent";
  const value: RemoteStateMarker = {
    id: asset.id,
    name: asset.name,
    digest: assetDigest(asset),
    size: asset.size,
    updatedAt: asset.updated_at,
  };
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

export function decodeMarker(value: string): DecodedMarker {
  if (value === "absent") return "absent";
  try {
    const decoded = JSON.parse(
      Buffer.from(value, "base64url").toString("utf8"),
    ) as RemoteStateMarker;
    if (
      !Number.isInteger(decoded.id) ||
      !decoded.name ||
      typeof decoded.digest !== "string" ||
      !Number.isInteger(decoded.size) ||
      !decoded.updatedAt
    ) {
      fail("Invalid marker in the protected restore receipt.");
    }
    return decoded;
  } catch {
    fail("Invalid marker in the protected restore receipt.");
  }
}

export function sameMarker(
  expected: RemoteStateMarker,
  actual: Asset,
): boolean {
  return (
    expected.id === actual.id &&
    expected.name === actual.name &&
    expected.digest === assetDigest(actual) &&
    expected.size === actual.size &&
    expected.updatedAt === actual.updated_at
  );
}

export function sameAssetMarker(left: Asset, right: Asset): boolean {
  return marker(left) === marker(right);
}
