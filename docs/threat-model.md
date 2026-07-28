# Threat model

## Security boundary

Protected assets are Terraform state, backup metadata, age identities, GitHub
tokens, consistency markers, and the managed Release namespace. The action
trusts the reviewed workflow, runner, and explicitly granted token. It treats
paths, API results after ambiguous failures, remote assets, and concurrent
writers as untrusted.

## Controls

| Threat                                   | Control                                                                |
| ---------------------------------------- | ---------------------------------------------------------------------- |
| State or credential disclosure           | No state/key outputs; masked secrets; escaped workflow commands        |
| Path traversal or symlink escape         | Workspace containment, real-directory checks, regular files only       |
| Corrupt or substituted state             | GitHub digest, SHA-256 verification, bound metadata                    |
| Stale concurrent writer                  | Consumer concurrency plus restore/save marker checks                   |
| Accidental empty-state recreation        | Explicit bootstrap; access errors remain failures                      |
| Partial replacement or backup corruption | Paired backups, compensation, orphan cleanup, metadata-first retention |
| Over-broad reset                         | Exact confirmation, namespace audit, post-delete verification          |
| Ambiguous API mutation                   | Reconcile expected remote content before accepting success             |
| Import branch overwrite or race          | Full tree diff, generated-path allowlist, expected head, non-force ref |
| Duplicate Terraform import target        | Structural HCL scan and explicit collision suppression                 |
| Import path symlink or realpath escape   | Lexical plus realpath containment; PR mode avoids local import reads   |
| Dependency compromise                    | Lockfile, pinned actions, dependency review, CodeQL, Dependabot        |

Age encryption uses native X25519 recipients. Identities remain masked and in
memory; plaintext state is not written to outputs, logs, artifacts, or caches.

Import proposals are read-only unless explicit PR mode is enabled. PR mode
writes only the configured imports file, never Terraform state. Generated
import IDs can be sensitive, so protect the target repository and review the PR.
The scan excludes the generated output and Terraform/tool cache directories;
malformed import blocks and symbolic links in the scanned tree fail closed.
The configured root cannot be a symlink or traverse symlink components. Local
`imports-path` content is read only in diff-only mode after regular-file,
non-symlink, and realpath containment checks; PR mode uses the remote base.

## Residual risks

- Release replacement is not atomic and does not provide locking or
  transactions.
- Plain state may contain secrets and depends on repository access controls.
- A lost age identity makes encrypted state and matching backups unrecoverable.
- A compromised workflow or runner can read plaintext state and supplied
  credentials.
- Filesystem checks cannot make an untrusted self-hosted runner safe.

Use least-privilege credentials, a shared concurrency group with
`cancel-in-progress: false`, reviewed workflows, and protected recovery
environments.
