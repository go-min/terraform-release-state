# Recovery and reset

This action does not run Terraform or decide whether infrastructure should be
recreated. The consumer workflow owns approvals, concurrency, credentials, and
the decision to restore or reset state.

## Reset contract

Use `operation: reset` only for a disposable Release or an explicitly approved
recovery. The action requires the exact value `confirmation: RESET` and
fails before making API changes when confirmation is absent or different.

Reset targets only the configured repository, Release tag, current state asset,
backup assets, and matching `.metadata.json` files. It first lists all Release
assets and refuses to proceed if an unexpected asset is present. This prevents
an accidentally shared Release from being deleted.

The deletion sequence is:

1. list all assets with GitHub API pagination;
2. delete the current state and backup assets;
3. list assets again and stop if any appeared during deletion;
4. delete the Release;
5. delete the tag reference.

Each delete treats HTTP 404 as already absent and retries transient API errors.
If a later delete fails, rerun the same confirmed reset. Already-deleted assets
are skipped and the remaining Release/tag resources are cleaned up.

## Clean bootstrap after reset

After reset, run restore with `bootstrap: true` in an approved workflow. If the
Release and state asset are absent, restore creates the empty state storage
boundary and returns `remote-state-marker: absent`. It does not import resources
or create infrastructure. Terraform can then create the initial local state,
which must be persisted with a subsequent `save`.

```yaml
- name: Reset approved disposable state
  uses: ter-sh/terraform-release-state@<commit-sha>
  with:
    operation: reset
    confirmation: RESET
    github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
    state-repository: ter-sh/terraform-release-state
    release-tag: terraform-state-test

- name: Recreate clean state storage
  id: restore-empty
  uses: ter-sh/terraform-release-state@<commit-sha>
  with:
    operation: restore
    bootstrap: "true"
    github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
    state-repository: ter-sh/terraform-release-state
    release-tag: terraform-state-test
    state-path: terraform.tfstate
```

## Production safeguards

- Do not use reset as an automatic response to a missing or corrupt state.
- Keep Terraform and reset jobs in separate approval paths.
- Use a short-lived GitHub App installation token where possible.
- Keep the consumer workflow's concurrency group with
  `cancel-in-progress: false`.
- Do not use the production `terraform-state` tag in integration tests.
