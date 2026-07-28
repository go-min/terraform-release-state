# Recovery and reset

The action fails closed when state is missing, corrupt, inaccessible, or
changed by another writer. Recovery is an operator decision; the action does
not recreate infrastructure, infer imports, or run Terraform.

## Failure responses

| Failure                                | Response                                                                                                |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| Release or current asset missing       | Investigate access/deletion; bootstrap only after approval                                              |
| Manifest, signature, or digest failure | Stop Terraform; inspect the latest complete backup and configured verification keys                     |
| `TRS_DECRYPTION_FAILED`                | Check that the supplied age identity matches; do not infer a plaintext digest mismatch                  |
| `TRS_PLAINTEXT_DIGEST_MISMATCH`        | Decryption succeeded but plaintext differs from the manifest; stop and investigate corruption           |
| Legacy age migration needs identity    | Supply the matching age identity and current recipients; no remote mutation has occurred                |
| Remote marker changed                  | Do not overwrite; restore again after resolving the competing writer                                    |
| Save replacement and recovery fail     | Preserve local state; inspect current and backup assets before mutation                                 |
| Retention fails after save             | If `state-write-committed=true`, use the emitted new marker; restore again and retry cleanup separately |
| Reset partially fails                  | Retry reset with the same target; deletions are idempotent                                              |
| Import branch has unrelated changes    | Preserve it; move the changes or choose a new reviewed `pr-branch`                                      |
| Obsolete import PR is closed           | Branch is retained; delete it only after manual review                                                  |
| Import path fails containment          | Replace symlinks with regular workspace paths; do not bypass the check                                  |

Import PR refresh never force-updates a branch. If the expected branch head
changes during refresh, rerun after inspecting the new diff. When generated
content already exists on base, an action-only open PR is closed but its branch
is retained because GitHub does not offer an expected-SHA condition for ref
deletion.

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
  uses: go-min/terraform-release-state@25c63506b7f9d288683dfff3c29a1e69f4fa4006 # v0.3.1
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
  uses: go-min/terraform-release-state@25c63506b7f9d288683dfff3c29a1e69f4fa4006 # v0.3.1
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
