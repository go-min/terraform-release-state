export const STATE_RELEASE_TAG = "terraform-state";
export const STATE_ASSET_NAME = "terraform.tfstate";
export const STATE_PATH = "terraform.tfstate";
export const BACKUP_RETENTION = 20;

export const TERRAFORM_ROOT = "terraform";
export const IMPORTS_PATH = "terraform/imports.generated.tf";
export const IMPORT_PR_BASE = "main";
export const IMPORT_PR_BRANCH = "terraform-release-state/imports.generated.tf";
export const IMPORT_PR_TITLE = "chore(terraform): update generated imports";

export const V04_MIGRATION_HINT =
  "Pin go-min/terraform-release-state@fb529572e17d20c414afacc7a7e14ffa0033058d (v0.4.0), restore and verify the state with its original age identities or Ed25519 verification keys, then save or reset it as plaintext unsigned storage before using v0.5.";
