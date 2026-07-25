# Terraform Release State

Store, restore, verify, and back up Terraform state using GitHub Release assets.

> [!NOTE]
> This project is maintained primarily for the organization's own use and
> shared as-is. It has no public support, roadmap, or response-time
> commitments. Forks are welcome for different workflows or priorities.

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

- `operation`: required, `restore`, `save`, or `reset`;
- `github-token`: required token with Contents access to the state repository;
- `state-repository`: defaults to `GITHUB_REPOSITORY`;
- `release-tag`: defaults to `terraform-state`;
- `state-asset`: defaults to `terraform.tfstate`;
- `state-path`: required for `restore` and `save`, workspace-relative local path;
- `bootstrap`: defaults to `false`;
- `expected-remote-state-marker`: restore output passed to save;
- `backup-retention`: defaults to `20`, maximum `1000`;
- `source-commit` and `workflow-run-id`: optional recovery metadata.
- `confirmation`: must be exactly `RESET` when `operation: reset`.

## Outputs

- `remote-state-marker`: opaque restore marker that must be passed to `save`;
- `bootstrapped`: `true` when the operation explicitly created missing state
  storage;
- `state-sha256`: checksum of the local state file;
- `state-asset-id` and `release-id`: GitHub identifiers for diagnostics;
- `backup-asset-name` and `backup-count`: save results.
- `reset-deleted-asset-count` and `reset-release-found`: reset results.

The action never returns state content, tokens, or keys as outputs.

## Reset

Reset is a destructive, explicitly confirmed operation for disposable or
approved recovery workflows. It deletes only the configured state Release's
current asset, `state-asset.backup-*` assets (including their `.metadata.json`
files), the Release, and its tag. It never runs Terraform or uses the `gh` CLI.

The action first lists every asset in the target Release. If any asset is
outside the configured current-state and backup namespace, reset fails before
deleting anything. A missing Release or tag is treated as already reset, so the
operation is safe to retry after a partial failure.

```yaml
- name: Reset disposable Terraform state
  uses: ter-sh/terraform-release-state@<commit-sha>
  with:
    operation: reset
    confirmation: RESET
    github-token: ${{ secrets.STATE_REPOSITORY_TOKEN }}
    state-repository: ter-sh/terraform-release-state
    release-tag: terraform-state-test
    state-asset: terraform.tfstate
```

Never expose `confirmation` as an unreviewed or user-controlled free-form
input. Use a protected workflow/environment for production recovery.

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

For reset recovery steps and partial deletion handling, see
[docs/recovery.md](docs/recovery.md).

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
- Backup metadata uses the `.metadata.json` format.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm format:check
pnpm lint
pnpm build
```

The implementation is split by responsibility:

- `src/config.mts` parses and validates the action inputs;
- `src/backups.mts` identifies backup assets and metadata files;
- `src/github-api.mts` contains the retrying GitHub Release/asset API adapter;
- `src/marker.mts` owns checksums and optimistic-consistency markers;
- `src/state-manager.mts` implements restore, save, backups, verification, and
  retention;
- `src/action-core.mts` contains the small GitHub Actions runtime adapter;
- `src/main.mts` is only the operation dispatcher.

Keep GitHub API calls in `src/github-api.mts`, state lifecycle decisions in
`src/state-manager.mts`, and pure validation/checksum behavior independently
testable. The native Node test runner covers pure logic; the disposable
integration workflow covers the live Release API contract.

The generated `dist/` bundle must be committed with action changes. Consumers
should pin the action to an immutable commit SHA. Stable `v1` will not be created
until the API and integration tests are reviewed.

The disposable integration workflow is manual-only. It creates a unique test
Release and removes it in an `always()` cleanup step; it never uses the
`terraform-state` production tag.

Design records are available in [discovery](docs/discovery.md),
[architecture](docs/architecture.md), [API/state/encryption decisions](docs/decisions.md),
and the [preview API review](docs/api-review.md). They describe preview behavior
only; no production migration is included.
