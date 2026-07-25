# Recovery and reset

Recovery is an operator decision. The action does not infer that missing or
corrupt state is safe to recreate, import resources, or run Terraform.

## Failure guide

| Failure                                | Safe response                                                               |
| -------------------------------------- | --------------------------------------------------------------------------- |
| Release or current asset is missing    | Investigate deletion/access; bootstrap only after explicit approval         |
| Integrity or metadata validation fails | Stop Terraform; verify the latest complete backup pair and encryption key   |
| Remote marker changed after restore    | Do not overwrite; rerun from restore after the competing writer is resolved |
| Save reports successful recovery       | Remote state was restored; investigate the failed replacement before retry  |
| Automatic recovery also fails          | Preserve local state and inspect current/backup assets before any mutation  |
| Retention or reset partially fails     | Retry the same operation; deletes are idempotent                            |

Never restore an older backup over a newer local state produced by a partially
successful `terraform apply`. Persist the newer local state first when its
lineage and remote marker are valid.

## Reset contract

Reset requires:

- `operation: reset`;
- exact `confirmation: RESET`;
- Contents write access to the configured state repository;
- an operator-approved recovery or disposable test context.

Before deletion, the action lists every Release asset and refuses a Release
containing anything outside the configured state namespace. It then deletes
state assets, rechecks the Release, deletes the Release, and deletes its tag.
HTTP `404` is treated as already absent, so the operation is safe to retry after
partial completion.

```yaml
- name: Reset approved state storage
  uses: ter-sh/terraform-release-state@<commit-sha>
  with:
    operation: reset
    confirmation: RESET
    github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
    state-repository: ter-sh/state-repository
    release-tag: terraform-state-recovery
```

Do not expose `confirmation` as an unreviewed workflow input. Use a protected
environment or equivalent approval boundary for non-disposable state.

## Clean bootstrap after reset

After reset, restore with explicit bootstrap. This creates the empty Release
boundary and returns `remote-state-marker: absent`; it does not create
infrastructure or state content.

```yaml
- name: Bootstrap clean state storage
  id: state
  uses: ter-sh/terraform-release-state@<commit-sha>
  with:
    operation: restore
    bootstrap: "true"
    github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
    state-repository: ter-sh/state-repository
    release-tag: terraform-state-recovery
    state-path: terraform.tfstate
```

Run Terraform only after reviewing why the previous state was reset. Persist
the resulting local state with `save` and
`expected-remote-state-marker: ${{ steps.state.outputs.remote-state-marker }}`.

## Encrypted recovery

GitHub access cannot recover age-encrypted state without a matching identity.
Retain every old identity until all backups encrypted for it have expired or
been intentionally removed. Test a new identity before removing an old
recipient from subsequent saves.
