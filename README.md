# Terraform Release State

Store, restore, verify, and back up Terraform state using GitHub Release assets.

> **This is not a native Terraform backend.** The action provides Terraform
> state storage through GitHub Release assets. The consumer workflow remains
> responsible for concurrency locking, Terraform execution, credentials, and
> protected environments.

## Status

This repository is a preview action. The initial milestone supports plain state
assets. Encryption is intentionally deferred until a separate API and recovery
design is reviewed.

## Usage

Restore before Terraform runs, then pass the restore marker to save. The marker
prevents a later save from silently overwriting state changed by another
process.

```yaml
permissions:
  contents: write

steps:
  - uses: actions/checkout@v5

  - name: Restore Terraform state
    id: state-restore
    uses: ter-sh/terraform-release-state@<commit-sha>
    with:
      operation: restore
      github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
      state-repository: ter-sh/terraform-release-state
      state-path: terraform.tfstate

  - name: Terraform apply
    run: terraform apply -input=false tfplan

  - name: Save Terraform state
    if: always()
    uses: ter-sh/terraform-release-state@<commit-sha>
    with:
      operation: save
      github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
      state-repository: ter-sh/terraform-release-state
      state-path: terraform.tfstate
      expected-remote-state-marker: ${{ steps.state-restore.outputs.remote-state-marker }}
      source-commit: ${{ github.sha }}
      workflow-run-id: ${{ github.run_id }}
```

Use `bootstrap: 'true'` only for explicit initial state creation or an approved
recovery procedure. It does not run Terraform import or create infrastructure.
Missing state fails closed by default.

## Inputs

- `operation`: required, `restore` or `save`;
- `github-token`: required token with Contents access to the state repository;
- `state-repository`: defaults to `GITHUB_REPOSITORY`;
- `release-tag`: defaults to `terraform-state`;
- `state-asset`: defaults to `terraform.tfstate`;
- `state-path`: required workspace-relative local path;
- `bootstrap`: defaults to `false`;
- `expected-remote-state-marker`: restore output passed to save;
- `backup-retention`: defaults to `20`, maximum `1000`;
- `source-commit` and `workflow-run-id`: optional recovery metadata.

## Outputs

- `remote-state-marker`: opaque restore marker that must be passed to `save`;
- `bootstrapped`: `true` when the operation explicitly created missing state
  storage;
- `state-sha256`: checksum of the local state file;
- `state-asset-id` and `release-id`: GitHub identifiers for diagnostics;
- `backup-asset-name` and `backup-count`: save results.

The action never returns state content, tokens, or keys as outputs.

## Behavior and recovery

The action verifies downloaded state against the GitHub asset digest when one is
available and always computes a local SHA-256. Before save it checks the remote
asset marker captured by restore. A mismatch fails without overwriting remote
state.

Save creates a timestamped backup and metadata asset before replacing the current
asset. It verifies the uploaded asset by downloading it again. The action tries
to restore the previous current asset if replacement upload fails, but GitHub
Release asset replacement is not atomic; inspect the latest backup if recovery
also fails.

The action can persist a state file after a failed Terraform step. The consumer
must call save with `if: always()` and preserve the restore marker.

## Security

- State content and credentials are never logged or returned as outputs.
- Paths are restricted to `GITHUB_WORKSPACE`.
- The action does not create plaintext recovery files.
- Use a short-lived GitHub App installation token where possible.
- For cross-repository storage, the token needs access to the state repository.
- The consumer workflow must provide `concurrency` with
  `cancel-in-progress: false`.
- Do not use a classic PAT as the primary production credential.

## Limitations

- The action does not run Terraform or provide state locking by itself.
- The first milestone stores plain assets only; age encryption is not included.
- Release assets are not an atomic or native Terraform backend.
- Backup cleanup failure is reported after the current state has been verified.

## Development

```bash
npm ci
npm run typecheck
npm test
npm run format:check
npm run build
```

The generated `dist/` bundle must be committed with action changes. Consumers
should pin the action to an immutable commit SHA. Stable `v1` will not be created
until the API and integration tests are reviewed.

The disposable integration workflow is manual-only. It creates a unique test
Release and removes it in an `always()` cleanup step; it never uses the
`terraform-state` production tag.
