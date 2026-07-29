# Recovery and reset

Recovery is an operator decision in a protected workflow. The action never
runs Terraform, recreates infrastructure, or guesses which backup is correct.

## Failure responses

| Failure                           | Required response                                                                 |
| --------------------------------- | --------------------------------------------------------------------------------- |
| Release/state absent              | Investigate access or deletion; use protected bootstrap only after approval       |
| `TRS_RESTORE_RECEIPT_REQUIRED`    | Run restore in the same job before save                                           |
| `TRS_REMOTE_CHANGED`              | Stop; inspect the competing writer and restore again                              |
| Manifest or digest failure        | Stop Terraform; do not promote unverified bytes                                   |
| `TRS_V04_MIGRATION_REQUIRED`      | Pin v0.4.0, decrypt/verify there, and migrate to plaintext unsigned storage       |
| Save/promotion rollback failure   | Preserve local state and inspect current plus safety backups before mutation      |
| `state-status=maintenance-failed` | Trust the emitted committed marker, run restore, then repair retention separately |
| Import branch unrelated changes   | Preserve the branch and move/review those changes before rerun                    |

Active v0.5 failures use stable codes: `TRS_CONFIG_INVALID`,
`TRS_OBJECT_NOT_FOUND`, `TRS_OBJECT_SET_INCOMPLETE`,
`TRS_MANIFEST_INVALID`, `TRS_MANIFEST_UNSUPPORTED_VERSION`,
`TRS_MANIFEST_OBJECT_MISMATCH`, `TRS_STORED_DIGEST_MISMATCH`,
`TRS_PLAINTEXT_DIGEST_MISMATCH`, `TRS_V04_MIGRATION_REQUIRED`,
`TRS_RESTORE_RECEIPT_REQUIRED`, `TRS_RESTORE_RECEIPT_INVALID`,
`TRS_REMOTE_CHANGED`, `TRS_API_FAILURE`, and `TRS_UNEXPECTED`. Older v0.4
crypto-specific codes remain reserved for output compatibility, but v0.5 has
no key or decryption execution path.

Never promote an older backup merely because it is newest by timestamp. Review
its Terraform serial, lineage correlation identifier, source workflow, and the
history of any partially successful apply.

## Reset all

`reset-target: all` audits the fixed `terraform-state` Release. It refuses
unrelated assets and encrypted/signed managed storage, then deletes the owned
assets, Release, and tag. Missing resources are already-reset success.

Confirmation is not an action input. The existing protected reset workflow
must require exact `RESET` confirmation before it invokes the action.

```yaml
- name: Delete approved state storage
  if: ${{ inputs.confirmation == 'RESET' }}
  uses: go-min/terraform-release-state@<v0.5.0-release-commit-sha> # v0.5.0
  with:
    operation: reset
    github-token: ${{ github.token }}
    reset-target: all
```

## Promote one backup

Supply the exact backup state object name, not its metadata or manifest:

```yaml
- name: Promote approved backup
  if: ${{ inputs.confirmation == 'RESET' }}
  uses: go-min/terraform-release-state@<v0.5.0-release-commit-sha> # v0.5.0
  with:
    operation: reset
    github-token: ${{ github.token }}
    reset-target: terraform.tfstate.backup-20260729T100000000Z-run-uuid
```

Promotion validates the exact target and current bundle, creates and verifies a
safety backup of current when present, repeats marker checks, replaces current
state with manifest last, and downloads it for verification. The selected
backup is not deleted or renamed.

If replacement fails, every observed partial current object is removed and the
complete prior current bundle is restored and verified. If current was absent,
recovery ensures no partial current remains. A safety backup created before a
later CAS conflict may remain intentionally.

Successful promotion emits `reset-action=promoted`, the exact `reset-target`,
`reset-promoted-marker`, and the standard committed lifecycle outputs. Run
restore before any subsequent save. The next save, not promotion, enforces
retention 20.

## Clean bootstrap

After approved `reset-target: all`, set `TERRAFORM_BOOTSTRAP=true` only on the
protected bootstrap job and run restore. It creates an empty Release and an
absent-state receipt. Terraform must create repository-root
`terraform.tfstate`; save then verifies and publishes it.

## Encrypted or signed v0.4 storage

v0.5 cannot decrypt or verify signatures and will not discard their security
properties implicitly. Use immutable v0.4.0
`fb529572e17d20c414afacc7a7e14ffa0033058d` with the original identities or
verification keys to restore and validate the state. Convert it deliberately
to plaintext unsigned storage before upgrading. Do not manually delete only a
metadata or signature companion.
