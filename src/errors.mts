export const ERROR_CODES = [
  "TRS_CONFIG_INVALID",
  "TRS_OBJECT_NOT_FOUND",
  "TRS_OBJECT_SET_INCOMPLETE",
  "TRS_MANIFEST_INVALID",
  "TRS_MANIFEST_UNSUPPORTED_VERSION",
  "TRS_MANIFEST_OBJECT_MISMATCH",
  "TRS_STORED_DIGEST_MISMATCH",
  "TRS_PLAINTEXT_DIGEST_MISMATCH",
  "TRS_DECRYPTION_FAILED",
  "TRS_SIGNATURE_REQUIRED",
  "TRS_SIGNATURE_INVALID",
  "TRS_SIGNATURE_KEY_UNKNOWN",
  "TRS_VERIFICATION_KEY_REQUIRED",
  "TRS_LEGACY_MIGRATION_IDENTITY_REQUIRED",
  "TRS_REMOTE_CHANGED",
  "TRS_API_FAILURE",
  "TRS_UNEXPECTED",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

export class ActionError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "ActionError";
    this.code = code;
  }
}

export function actionError(
  code: ErrorCode,
  message: string,
  options?: ErrorOptions,
): ActionError {
  return new ActionError(code, message, options);
}

export function failWithCode(code: ErrorCode, message: string): never {
  throw actionError(code, message);
}

function hasHttpStatus(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "status" in error &&
    typeof error.status === "number"
  );
}

export function normalizeActionError(error: unknown): ActionError {
  if (error instanceof ActionError) return error;
  const message =
    error instanceof Error ? error.message : "Terraform Release State failed.";
  return actionError(
    hasHttpStatus(error) ? "TRS_API_FAILURE" : "TRS_UNEXPECTED",
    message,
    error instanceof Error ? { cause: error } : undefined,
  );
}

export function displayError(error: ActionError): string {
  return `[${error.code}] ${error.message}`;
}
