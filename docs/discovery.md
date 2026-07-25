# Discovery report

Status: preview action, reviewed after `v0.1.0-preview.5`. This document
describes the extracted action itself. It does not authorize or describe a
production migration.

## Current implementation

| Area              | Files                                                   | Responsibility                                                             |
| ----------------- | ------------------------------------------------------- | -------------------------------------------------------------------------- |
| Action contract   | `action.yml`, `src/config.mts`                          | Inputs, outputs, Node 24 entrypoint, validation wiring                     |
| GitHub API        | `src/github-api.mts`                                    | Release lookup/creation, paginated assets, upload/download/delete, retries |
| State lifecycle   | `src/state-manager.mts`                                 | Restore, save, consistency checks, backup, verification, retention         |
| Reset lifecycle   | `src/reset.mts`, `src/reset-core.mts`                   | Confirmed deletion of one state Release, assets, backups, and tag          |
| Markers/integrity | `src/marker.mts`                                        | SHA-256 and opaque remote asset marker                                     |
| Backup namespace  | `src/backups.mts`, `src/backup-names.mts`               | Backup classification, metadata naming, collision-resistant names          |
| Local files       | `src/state-files.mts`, `src/validation.mts`             | Workspace containment, secure directory/file creation, input validation    |
| Runtime adapter   | `src/action-core.mts`, `src/main.mts`                   | Action inputs/outputs, masking, failure reporting, dispatch                |
| Verification      | `tests/*.test.mts`, `.github/workflows/integration.yml` | Native unit tests and disposable live Release coverage                     |

## Reusable boundary

The reusable boundary is the Release asset lifecycle. It accepts a repository,
tag, asset name, and workspace path; it does not know how Terraform is run.
The consumer remains responsible for:

- Terraform init/plan/apply and credentials;
- workflow concurrency and `cancel-in-progress: false`;
- approvals, protected environments, and branch policy;
- choosing whether a reset is appropriate;
- creating a GitHub App and obtaining its installation token.

## State format

The current format is deliberately small and versionless during preview:

- current plain asset: `terraform.tfstate` by default;
- backups: `terraform.tfstate.backup-*`;
- backup metadata: `<backup-name>.metadata.json`;
- no legacy `.metadata.txt` support;
- no encryption envelope in the current milestone.

The marker is operational metadata, not persisted state format. It contains the
current asset identity, digest, size, and update timestamp, encoded as an opaque
output for the restore/save pair.

## Existing assumptions and failure modes

Covered assumptions include a dedicated state Release, explicit bootstrap,
cross-repository Contents access, paginated asset listing, transient API retry,
asset digest verification, non-atomic asset replacement, backup retention, and
optimistic consistency protection.

The action fails closed for missing state without bootstrap, marker mismatch,
invalid paths, invalid repository/tag/asset input, unexpected reset assets, and
non-retryable API failures. Reset and delete operations treat 404 as already
absent so a retry can complete after a partial failure.

Remaining external assumptions are that the configured Release is dedicated to
this state namespace and that the consumer supplies workflow-level locking.

## Extraction result

The extracted action no longer depends on a production repository's scripts,
Terraform command, or `gh` CLI. Its only runtime package dependency is
`@actions/github`; the generated bundle is committed for action consumers.
