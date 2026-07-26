# Changelog

Release history for Terraform Release State.

## [0.2.1] — 2026-07-26

### Fixes

- Normalize `github_repository_ruleset` imports to
  `<repository>:<ruleset_id>`.
- Normalize `github_repository_vulnerability_alerts` imports to
  `<repository>`.
- Skip provider-specific resources when the required repository attribute is
  missing, with an explicit reason.
- Preserve generic import IDs and already-normalized ruleset IDs.
- Use `terraform-release-state/<imports-filename>` for the default generated
  import proposal branch.

### Safety

StateImport reads state from GitHub Release assets, does not modify state, run
Terraform, or apply infrastructure changes. Review every generated import
target and the resulting Terraform plan before merging.

## [0.2.0] — 2026-07-26

### Highlights

- Add the storage-backed `StateImport` operation.
- Read Terraform state from the managed GitHub Release asset without creating a
  local state file.
- Generate deterministic Terraform import blocks with a safe review diff.
- Optionally create or update a focused pull request in the consumer
  repository.
- Keep state contents, credentials, and private keys out of logs and outputs.

### Safety

StateImport does not run Terraform or modify infrastructure. Review every
import target and the resulting Terraform plan before merging.

## [0.1.0] — 2026-07-25

The first stable 0.x release of the reusable GitHub Action for storing
Terraform state in GitHub Release assets.

### Included

- Restore and save operations with explicit bootstrap.
- Optimistic consistency checks that reject stale writes.
- SHA-256 integrity verification and upload verification.
- Paired state backups with metadata and configurable retention.
- Guarded recovery after partial replacement failures.
- Native fail-closed reset of the dedicated state Release.
- Optional age encryption for current state and backups.
- Node.js 24 runtime with committed, verified `dist` bundle.

### Security

Use a private state repository for production because Release assets inherit
repository visibility. Prefer short-lived GitHub App installation tokens for
cross-repository access. Never expose state, credentials, tokens, or private
keys in logs or outputs.

The API remains pre-v1 and may change before v1. This release performs no
production migration.

[0.2.1]: https://github.com/ter-sh/terraform-release-state/releases/tag/v0.2.1
[0.2.0]: https://github.com/ter-sh/terraform-release-state/releases/tag/v0.2.0
[0.1.0]: https://github.com/ter-sh/terraform-release-state/releases/tag/v0.1.0
