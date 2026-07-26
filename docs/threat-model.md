# Threat model

## Protected assets

- Terraform state and encrypted backups;
- GitHub tokens and age identities;
- recovery metadata and optimistic consistency markers;
- the dedicated state Release and tag.

## Trust boundaries

The action trusts the reviewed consumer workflow, GitHub Actions runtime, and
the permissions intentionally granted to its token. It does not trust local
path components, remote assets, caller-provided names, API results after
ambiguous failures, or concurrent writers.

## Threats and controls

| Threat                              | Control                                                                    |
| ----------------------------------- | -------------------------------------------------------------------------- |
| State or credential disclosure      | No state/key outputs; workflow commands escaped; secret inputs masked      |
| Path traversal or symlink escape    | Workspace-relative validation, real-directory checks, regular files only   |
| Corrupt or substituted asset        | GitHub digest, local SHA-256, upload download-verification, bound metadata |
| Stale or concurrent writer          | Consumer concurrency plus opaque restore/save marker checks                |
| Implicit empty-state recreation     | Explicit bootstrap; access and integrity errors remain failures            |
| Partial replacement                 | Paired backup plus guarded recovery from the downloaded previous state     |
| Backup pair corruption              | Paired metadata, compensation, orphan cleanup, metadata-first retention    |
| Over-broad reset                    | Exact confirmation, namespace audit, post-delete audit                     |
| Ambiguous non-idempotent API result | Remote reconciliation before accepting create/upload success               |
| Dependency compromise               | Pinned packages/actions, lockfile, dependency review, CodeQL, Dependabot   |

Encrypted state uses the interoperable age format with native X25519
recipients. Identities are masked line-by-line and remain in memory; the action
does not write them to files or outputs.

`operation: import` is read-only by default. Its optional PR mode writes only
the configured imports file to a dedicated branch and requires explicit
`create-pr: "true"`. The generated file can contain provider resource IDs, so
the target repository and pull request must be treated as potentially
sensitive.

PR mode compares the generated file with the remote base branch, refuses to
overwrite a pre-existing branch with unrelated changes unless it already has
an open StateImport PR, and never commits Terraform state. The token must have
read access to the state repository and write plus pull-request access to the
target repository. A GitHub App installation token is preferred for this
cross-repository case.

## Residual risks

- GitHub Release replacement is not atomic and does not provide native backend
  transactions or locking.
- Plain state assets may contain secrets and rely entirely on repository access
  controls.
- A lost age identity makes matching state and backups unrecoverable.
- A compromised workflow or runner can access local plaintext state and any
  credentials intentionally provided to it.
- Filesystem checks reduce path attacks but cannot make an untrusted
  self-hosted runner safe.

Consumers must use a shared concurrency group with `cancel-in-progress: false`,
least-privilege credentials, reviewed workflows, and protected environments for
destructive recovery.
