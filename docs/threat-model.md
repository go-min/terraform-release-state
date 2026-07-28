# Threat model

## Security boundary

Protected assets are Terraform state, manifests, signatures, backup metadata,
age identities, signing private keys, GitHub tokens, consistency markers, and
the managed Release namespace. The action
trusts the reviewed workflow, runner, and explicitly granted token. It treats
paths, API results after ambiguous failures, remote assets, and concurrent
writers as untrusted.

## Controls

| Threat                                   | Control                                                                                                  |
| ---------------------------------------- | -------------------------------------------------------------------------------------------------------- |
| State or credential disclosure           | No state/key outputs; masked secrets; escaped workflow commands                                          |
| Path traversal or symlink escape         | Workspace containment, real-directory checks, regular files only                                         |
| Corrupt or substituted state             | Strict manifests, stored/plaintext SHA-256 and size bindings, optional Ed25519 verification              |
| Stale concurrent writer                  | Consumer concurrency plus restore/save marker checks                                                     |
| Accidental empty-state recreation        | Explicit bootstrap; access errors remain failures                                                        |
| Partial replacement or backup corruption | Download every new bundle object before replacement; compensation; signature-first fail-closed retention |
| Over-broad reset                         | Exact confirmation, namespace audit, post-delete verification                                            |
| Ambiguous API mutation                   | Reconcile expected remote content before accepting success                                               |
| Import branch overwrite or race          | Full tree diff, generated-path allowlist, expected head, non-force ref                                   |
| Duplicate Terraform import target        | Structural HCL scan and explicit collision suppression                                                   |
| Import path symlink or realpath escape   | Lexical plus realpath containment; PR mode avoids local import reads                                     |
| Dependency compromise                    | Lockfile, pinned actions, dependency review, CodeQL, Dependabot                                          |

Age encryption uses native X25519 recipients. Identities remain masked and in
memory; plaintext state is not written to outputs, logs, artifacts, or caches.
Digest outputs contain only hashes: `stored-state-sha256` covers stored bytes
and `plaintext-state-sha256` covers decrypted state. Existing `state-digest`
and `state-sha256` meanings remain compatible.

Manifest and signature assets are canonicalized and strictly validated; unknown
or reordered fields, unsupported schema versions, object-name mismatches,
unknown signing keys, and signature failures stop the operation. A present
manifest is never ignored in favor of legacy metadata. The age recipient-set
fingerprint and Ed25519 public-key fingerprint are non-secret SHA-256
identifiers. Terraform lineage may be recorded because it is an infrastructure
correlation identifier; state resources, outputs, provider data, and plaintext
values are not copied into manifests or action outputs.

The default signature policy permits unsigned legacy migration with an explicit
warning. Signed objects never degrade to unverifiable reads: even under
`allow-unsigned`, a present signature requires a matching configured public
key. `require` rejects unsigned state and requires save to sign new objects.

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
- A lost Ed25519 verification key makes objects signed only by that key
  unverifiable under the required policy.
- A compromised workflow or runner can read plaintext state and supplied
  credentials.
- Filesystem checks cannot make an untrusted self-hosted runner safe.

Use least-privilege credentials, a shared concurrency group with
`cancel-in-progress: false`, reviewed workflows, and protected recovery
environments.
