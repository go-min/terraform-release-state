# Threat model

## Assets and trust boundaries

The protected assets are Terraform state, GitHub tokens, recovery metadata, and
the dedicated state Release/tag. The action trusts the consumer workflow's
approved inputs, GitHub Actions runtime, and token scope. It does not trust
state-path components, remote Release assets, API responses after transient
failures, or concurrent writers.

## Controls

- State paths are restricted to real, non-symlink workspace directories and
  regular files.
- State files are written through a `0600` temporary file and atomically renamed.
- Restore/save use opaque remote markers and fail closed on state changes.
- Downloads verify GitHub asset digests when available; uploads are downloaded
  and checked before success is reported.
- Backup assets and metadata remain in a dedicated namespace; reset validates
  that namespace before deletion and rechecks it before deleting the Release.
- Delete 404s are idempotent; create/upload ambiguity is reconciled by inspecting
  the remote resource rather than retrying a non-idempotent POST blindly.
- State, credentials, and keys are never logged or returned through outputs.
- Encrypted state uses age ciphertext plus versioned current metadata; missing
  or incompatible metadata fails closed instead of falling back to plaintext.

## Residual risks

- GitHub Release asset replacement is not atomic. A verified backup is the
  recovery source if replacement or recovery fails.
- The action cannot provide workflow-level locking; consumers must configure a
  shared concurrency group with `cancel-in-progress: false`.
- Plain state assets can contain secrets. Encrypted state still requires secure
  recipient/identity rotation and protection of GitHub Actions secrets.
- Filesystem checks reduce symlink traversal but cannot replace an isolated,
  trusted runner and reviewed workflow inputs.
