# Threat model

## Boundary

Protected assets are plaintext Terraform state, canonical manifests, backup
metadata, consistency receipts, GitHub tokens, and the fixed Release namespace.
The action trusts the reviewed workflow, GitHub-hosted runner, current
repository context, and explicitly granted token. Remote API results,
filesystem paths, concurrent writers, and generated import branches are
untrusted.

## Controls

| Threat                            | Control                                                                            |
| --------------------------------- | ---------------------------------------------------------------------------------- |
| State or credential disclosure    | No state/token outputs; secret masking; escaped workflow commands                  |
| Cross-repository confused deputy  | Repository derived only from `github.context.repo`                                 |
| Path traversal or symlink escape  | Fixed root paths plus lexical, realpath, and regular-file checks                   |
| Corrupt or substituted state      | Strict canonical manifest and stored/plaintext SHA-256 plus size bindings          |
| Stale concurrent writer           | Protected workflow concurrency and repository-bound restore receipt CAS            |
| Accidental empty-state recreation | Exact `TERRAFORM_BOOTSTRAP=true` environment boundary                              |
| Partial upload/replacement        | Download verification, manifest-last completion, compensating rollback             |
| Unsafe legacy downgrade           | Encrypted/signed objects fail before mutation with v0.4 migration guidance         |
| Over-broad reset                  | Fixed namespace, workflow-owned confirmation, exact backup-name validation         |
| Backup promotion race             | Current and selected bundle markers rechecked after verified safety backup         |
| Import overwrite                  | Full merge-base tree diff, one-path allowlist, expected SHA, non-force ref update  |
| Duplicate import target           | Structural HCL tokenizer/parser and explicit suppression                           |
| Dependency compromise             | Frozen lockfile policy, pinned actions/toolchain, audit, dependency review, CodeQL |

`state-sha256` and `plaintext-state-sha256` cover plaintext. The v0.5 stored
bytes are the plaintext bytes, so `stored-state-sha256` is equal. Digests are
not state values, but state may still contain secrets and requires repository
access controls appropriate for plaintext storage.

Terraform lineage may appear in a manifest because it is an infrastructure
correlation identifier. Resource values, Terraform outputs, provider data, and
credentials are never copied into manifests, workflow summaries, or action
outputs.

The receipt is stored beneath trusted `RUNNER_TEMP`, uses a deterministic
repository binding and mode 0600, and is accepted only as canonical internal
JSON. It cannot be supplied through the action API. A compromised runner can
still read state and the receipt; filesystem checks do not make an untrusted
self-hosted runner safe.

Import always writes a same-repository pull request and can expose provider
import IDs to repository readers. Protect the repository and review every
generated target and plan. The action does not run Terraform.

## Residual risks

- GitHub Release replacement is not atomic and is not backend locking.
- A compromised protected workflow or runner can read or replace plaintext
  state using its granted permissions.
- GitHub API availability can leave post-commit retention incomplete; committed
  outputs distinguish this from replacement failure.
- Workflow-level reset confirmation and environment protection are outside the
  action boundary.
- A lost v0.4 identity or verification key can make encrypted/signed historical
  storage unrecoverable before migration.

Use least-privilege `GITHUB_TOKEN` permissions, a shared concurrency group with
`cancel-in-progress: false`, reviewed workflow changes, and protected bootstrap
and reset environments.
