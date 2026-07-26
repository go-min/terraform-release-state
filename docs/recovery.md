# Recovery and reset

The action fails closed when state is missing, corrupt, inaccessible, or
changed by another writer. Recovery is an operator decision; the action does
not recreate infrastructure, infer imports, or run Terraform.

## Failure responses

| Failure                            | Response                                                                |
| ---------------------------------- | ----------------------------------------------------------------------- |
| Release or current asset missing   | Investigate access/deletion; bootstrap only after approval              |
| Integrity or metadata failure      | Stop Terraform; inspect the latest complete backup and key              |
| Remote marker changed              | Do not overwrite; restore again after resolving the competing writer    |
| Save replacement and recovery fail | Preserve local state; inspect current and backup assets before mutation |
| Retention fails after save         | Treat the new current state as authoritative; retry cleanup separately  |
| Reset partially fails              | Retry reset with the same target; deletions are idempotent              |

Never restore an older backup over a newer local state from a partially
successful `terraform apply`. Save the newer local state first when its marker
and lineage are valid.

## Reset

Reset requires `operation: reset`, exact `confirmation: RESET`, and Contents
write access to the configured state repository. Before deletion it audits all
Release assets and refuses unexpected assets. It then deletes only the managed
current asset, metadata, backups, Release, and tag. A missing resource is
already-reset success.

Protect reset behind a reviewed workflow, protected environment, or equivalent
approval boundary:

```yaml
- name: Reset approved state storage
  uses: ter-sh/terraform-release-state@322dbb7a0bb51951222ddd86fe800531b1ef9a6b # v0.2.1
  with:
    operation: reset
    confirmation: RESET
    github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
    state-repository: owner/state-repository
```

## Clean bootstrap

After an approved reset, restore with explicit bootstrap. This creates an empty
Release boundary and returns the opaque `remote-state-marker: absent`; it does
not create state content or infrastructure.

```yaml
- name: Bootstrap clean state storage
  id: state-restore
  uses: ter-sh/terraform-release-state@322dbb7a0bb51951222ddd86fe800531b1ef9a6b # v0.2.1
  with:
    operation: restore
    bootstrap: "true"
    github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
    state-repository: owner/state-repository
    state-path: terraform.tfstate
```

Run Terraform only after reviewing why state was reset. Save the resulting
state with the marker from `state-restore`.

## Encrypted recovery

GitHub access cannot decrypt age-encrypted state without a matching identity.
Retain old identities until all backups encrypted for them have expired or
been intentionally removed. Test a new identity before removing the old one.
