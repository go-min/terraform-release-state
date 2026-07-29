# Recovery and reset

Recovery is an operator decision in a protected workflow. The action never runs
Terraform, recreates infrastructure, or chooses a backup automatically.

| Signal                                                 | Response                                                                                              |
| ------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| `TRS_RESTORE_RECEIPT_REQUIRED` or `TRS_REMOTE_CHANGED` | Stop and run restore again in the same serialized job.                                                |
| Digest, manifest, signature, or decryption failure     | Stop Terraform. Preserve Release assets and investigate keys/bytes; do not promote unverified data.   |
| `TRS_DECRYPTION_FAILED`                                | Supply the matching `age-identities`; this does not mean a plaintext digest mismatch.                 |
| `TRS_SIGNATURE_REQUIRED`                               | Supply a matching verification key, and a private signing key before replacing signed current state.  |
| `state-status=maintenance-failed`                      | The emitted marker is authoritative. Run restore before another save and repair retention separately. |
| Import branch unrelated changes                        | Preserve/review them; the action intentionally refuses overwrite.                                     |

`reset-target: all` requires workflow-owned exact confirmation. It audits only
the configured state namespace, then deletes assets, Release, and tag. An exact
`state-asset.backup-*` target verifies selected/current bundles, creates and
verifies a safety backup, rechecks markers, and promotes with manifest last.
The target remains. Failed replacement removes observed partial current objects
and restores the full previous bundle.

Bootstrap is canonical input `bootstrap: true` on protected restore. The legacy
`TERRAFORM_BOOTSTRAP=true` fallback works only when the input was omitted.
Bootstrap creates an empty Release and absent-state receipt; save then publishes
the first local state.

v0.6 reads v0.4 age/signed and v0.5 plaintext manifests in their original
namespace. Provide the original age identity and verification key; do not delete
metadata or signature companions. A crypto migration happens only through an
authenticated save or reset promotion.
