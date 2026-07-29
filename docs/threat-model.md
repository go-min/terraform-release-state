# Threat model

Protected material includes Terraform state, manifests/signatures, backup
metadata, receipts, crypto keys, and the configured Release namespace. The
action trusts a reviewed protected workflow, GitHub context, and its token.
GitHub API results, filesystem paths, concurrent writers, and import branches
are untrusted.

| Threat                     | Control                                                                                                                                  |
| -------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| State disclosure           | No state/key outputs; restrictive local files; secret masking. Age encryption is available when plaintext Release storage is unsuitable. |
| Corrupt/substituted bytes  | Strict canonical manifest/signature parsing, stored and plaintext SHA-256/size checks, and upload download verification.                 |
| Signature downgrade        | Signed current state requires a private key before a safety backup or replacement; policy can require signatures.                        |
| Stale writer               | Protected workflow serialization plus repository/tag/asset-bound restore receipt CAS.                                                    |
| Partial replacement        | Manifest-last completion and verified full-bundle compensating rollback.                                                                 |
| Cross-repository confusion | Storage repository is explicit and validated; source provenance remains GitHub-derived; import PRs stay in the workflow repository.      |
| Path/symlink escape        | Lexical containment, realpath validation, and regular-file checks.                                                                       |
| Reset/import overwrite     | Workflow-owned reset confirmation; exact backup validation; full branch diff allowlist and lease-style ref update.                       |

`state-sha256` and `plaintext-state-sha256` cover plaintext.
`stored-state-sha256` covers exact Release bytes and differs for age encryption.
Digests, lineage, and provenance are correlation data, not state values, but
repository access must still be protected.

Residual risks remain: GitHub Release replacement is not transactional backend
locking, a compromised writer can access granted material, lost age/signing keys
can make historical data unrecoverable, and API loss can leave post-commit
retention incomplete. Use least privilege, protected environments, reviewed
workflow changes, and a shared concurrency group with `cancel-in-progress: false`.
