# Terraform Release State

[![Check](https://github.com/ter-sh/terraform-release-state/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/ter-sh/terraform-release-state/actions/workflows/check.yml)
[![Disposable integration](https://github.com/ter-sh/terraform-release-state/actions/workflows/integration.yml/badge.svg?branch=main)](https://github.com/ter-sh/terraform-release-state/actions/workflows/integration.yml)
[![Security](https://github.com/ter-sh/terraform-release-state/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/ter-sh/terraform-release-state/actions/workflows/security.yml)
[![Node.js 24](https://img.shields.io/badge/runtime-Node.js%2024-339933?logo=nodedotjs&logoColor=white)](action.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Store, restore, verify, encrypt, and back up Terraform state with GitHub Release
assets.

> [!IMPORTANT]
> This action is not a native Terraform backend. It does not run Terraform or
> provide locking. The consumer workflow remains responsible for Terraform
> execution, concurrency, credentials, approvals, and protected environments.

## What it provides

- explicit `restore`, `save`, and `reset` operations;
- fail-closed bootstrap and integrity validation;
- optimistic consistency protection against stale writes;
- paired backups with checksums and configurable retention;
- recovery after a partially failed state replacement;
- optional `age` encryption with native X25519 recipients;
- same-repository and cross-repository state storage;
- a read-only `StateImport` operation for proposing Terraform imports;
- no Terraform state, token, or private key outputs.

GitHub Releases provide a repository-scoped asset store with permissions,
checksums, and recovery-friendly immutable backup names. They do not provide
Terraform's native locking or transactional backend semantics.

## Quick start

Pin the action to an immutable commit SHA. Restore before Terraform runs and
save with `if: always()` so state produced by a partially successful apply is
still persisted.

```yaml
permissions:
  contents: write

concurrency:
  group: terraform-state
  cancel-in-progress: false

steps:
  - uses: actions/checkout@fbc6f3992d24b796d5a048ff273f7fcc4a7b6c09 # v5

  - name: Restore Terraform state
    id: state
    uses: ter-sh/terraform-release-state@<commit-sha>
    with:
      operation: restore
      github-token: ${{ github.token }}
      state-path: terraform.tfstate

  - name: Terraform apply
    run: terraform apply -input=false tfplan

  - name: Save Terraform state
    if: always() && steps.state.outcome == 'success'
    uses: ter-sh/terraform-release-state@<commit-sha>
    with:
      operation: save
      github-token: ${{ github.token }}
      state-path: terraform.tfstate
      expected-remote-state-marker: ${{ steps.state.outputs.remote-state-marker }}
```

The default storage location is the current repository, Release tag
`terraform-state`, and asset `terraform.tfstate`.

Every workflow in the consumer repository that writes this asset must use the
same concurrency group. Concurrency groups do not coordinate across different
repositories; cross-repository writers rely on the action's consistency check
to reject stale saves and should be operationally serialized where possible.

### StateImport

`operation: import` downloads the current state asset from GitHub Release,
validates it like `restore`, proposes import blocks for managed instances with
a string or numeric `attributes.id`, and prints a diff without modifying the
workspace. It skips data resources and instances without a usable ID. The
The output file path is configurable:

```yaml
- name: Propose Terraform imports
  uses: ter-sh/terraform-release-state@<commit-sha>
  with:
    operation: import
    github-token: ${{ github.token }}
    imports-path: infrastructure/generated-imports.tf
```

StateImport is not a provider-aware import planner. Review provider-specific
IDs and the corresponding resource configuration before applying. In its
default mode it only prints a diff: it does not write files, create commits, or
open pull requests. Terraform is never run, and state is never returned through
outputs or written to the workspace.

To opt in to PR creation, set `create-pr: "true"`:

```yaml
permissions:
  contents: write
  pull-requests: write

with:
  operation: import
  create-pr: "true"
  imports-path: infrastructure/generated-imports.tf
```

`pr-base` defaults to `GITHUB_REF_NAME`; `pr-branch` is derived from the
imports filename. Set them explicitly only when the workflow ref is not the
intended writable base branch.

The action compares the generated file with the remote base branch. If it is
different, it creates or reuses the named branch, commits only the imports file,
and opens or reuses one open pull request. The default is `create-pr: "false"`.
An existing branch with unrelated manual changes is rejected rather than
overwritten. The PR does not run Terraform or apply infrastructure changes.

## Lifecycle

### Restore

Restore downloads the current asset, verifies its GitHub digest and encryption
metadata when present, decrypts it when configured, and writes the local state
with mode `0600`. Missing or invalid state fails without changing the local
file.

Initial storage creation is explicit:

```yaml
with:
  operation: restore
  bootstrap: "true"
```

Use bootstrap only for first-time setup or an approved recovery. A permission
or API error is never interpreted as missing state.

### Save

Save requires the opaque marker returned by restore whenever current state
exists. Before replacement, it checks the marker again, creates a backup and
JSON metadata pair, uploads the new state, downloads it for verification, and
applies retention. A remote change aborts the save instead of using
last-write-wins.

GitHub Release asset replacement is not atomic. If replacement fails, the
action restores the previous state when it can prove no concurrent writer has
changed the target. Otherwise it fails with recovery context.

### Reset

Reset is destructive and requires the exact confirmation `RESET`. It audits the
target Release before deleting only the configured current state, metadata,
backups, Release, and tag. Unexpected assets stop the operation before the
Release is removed. Missing resources are treated as already reset.

See [Recovery and reset](docs/recovery.md) for the procedure and clean bootstrap
sequence.

## Encryption

Set `encryption: age` to store ciphertext while Terraform continues to use the
plaintext file at `state-path`.

```yaml
# Restore
encryption: age
age-identities: ${{ secrets.TF_STATE_AGE_IDENTITIES }}

# Save
encryption: age
age-recipients: ${{ vars.TF_STATE_AGE_RECIPIENTS }}
```

Only native X25519 `age1...` recipients and
`AGE-SECRET-KEY-1...` identities are supported. Passphrases, SSH keys, plugins,
and automatic plain/encrypted migrations are not supported. Use a dedicated
Release tag for new encrypted storage.

For rotation, save once with old and new recipients, verify restore with the
new identity, then save with only the new recipient. Retain the old identity
until every backup encrypted for it is outside the retention window.

## Cross-repository storage

Set `state-repository: owner/name` and provide a token scoped to that repository.
The workflow's default `GITHUB_TOKEN` normally cannot write to another
repository. Prefer a short-lived GitHub App installation token; do not use a
classic PAT as the primary production credential.

Minimum token permissions:

| Operation           | Repository permission                    |
| ------------------- | ---------------------------------------- |
| `restore`           | Contents: read                           |
| `restore` bootstrap | Contents: write                          |
| `save`              | Contents: write                          |
| `reset`             | Contents: write                          |
| `import`            | Contents: read                           |
| `import` with PR    | Contents: write and Pull requests: write |

## Inputs

| Input                          | Default                  | Description                                                         |
| ------------------------------ | ------------------------ | ------------------------------------------------------------------- |
| `operation`                    | required                 | `restore`, `save`, `reset`, or `import`                             |
| `github-token`                 | required                 | Token with access to the state repository                           |
| `state-repository`             | current repository       | Repository in `owner/name` format                                   |
| `release-tag`                  | `terraform-state`        | Dedicated state Release tag                                         |
| `state-asset`                  | `terraform.tfstate`      | Current state asset name                                            |
| `state-path`                   | —                        | Workspace-relative file path; required for restore/save             |
| `bootstrap`                    | `false`                  | Explicitly allow missing storage creation                           |
| `expected-remote-state-marker` | empty                    | Marker returned by restore and required for updating existing state |
| `backup-retention`             | `20`                     | Number of backup pairs to retain, from `0` through `1000`           |
| `source-commit`                | `GITHUB_SHA`             | Commit SHA recorded in backup metadata                              |
| `workflow-run-id`              | `GITHUB_RUN_ID`          | Workflow run ID recorded in backup metadata                         |
| `confirmation`                 | empty                    | Must equal `RESET` for reset                                        |
| `encryption`                   | `none`                   | `none` or `age`                                                     |
| `age-recipients`               | empty                    | Newline-delimited public recipients required for encrypted save     |
| `age-identities`               | empty                    | Secret newline-delimited identities required for encrypted restore  |
| `imports-path`                 | `./imports.generated.tf` | Workspace-relative path to the StateImport output file              |
| `create-pr`                    | `false`                  | Opt in to creating or updating a StateImport pull request           |
| `pr-base`                      | current ref              | Base branch for the pull request                                    |
| `pr-branch`                    | derived                  | Dedicated branch for the pull request                               |
| `pr-title`                     | conventional title       | Pull request title                                                  |

## Outputs

| Output                      | Description                                    |
| --------------------------- | ---------------------------------------------- |
| `operation`                 | Completed operation                            |
| `bootstrapped`              | Whether missing storage was explicitly created |
| `release-id`                | Target GitHub Release ID                       |
| `state-asset-id`            | Current state asset ID, when present           |
| `remote-state-marker`       | Opaque marker passed from restore to save      |
| `state-digest`              | SHA-256 digest of the stored asset             |
| `state-sha256`              | SHA-256 checksum of the local state file       |
| `backup-asset-name`         | Backup created by save, when applicable        |
| `backup-count`              | Retained complete backup pairs                 |
| `reset-deleted-asset-count` | Assets deleted by reset                        |
| `reset-release-found`       | Whether reset found the target Release         |
| `import-pr-url`             | Pull request URL created or reused by import   |

The action never returns state content, credentials, or encryption keys.

## Storage layout

```text
terraform.tfstate
terraform.tfstate.metadata.json                  # encrypted state only
terraform.tfstate.backup-<timestamp>-<run>-<uuid>
terraform.tfstate.backup-<timestamp>-<run>-<uuid>.metadata.json
```

Backup metadata records the timestamp, source commit, workflow run ID, action
version, current asset name, encryption mode, and stored-asset checksum. Only
`.metadata.json` is supported.

## Failure behavior

The action fails closed for:

- missing storage without explicit bootstrap;
- invalid inputs or unsafe paths;
- missing, malformed, or mismatched encryption metadata;
- checksum or upload verification failures;
- remote state changes after restore;
- unexpected assets during reset;
- authentication and permission errors.

Transient reads and deletes use bounded retries. Create and upload ambiguity is
resolved by inspecting the remote resource rather than blindly repeating a
non-idempotent request.

## Security

> [!WARNING]
> Never store plaintext Terraform state in a public repository. GitHub Release
> assets inherit repository visibility. Use a dedicated private state
> repository for production, including when encryption is enabled.

The action masks tokens and multiline age identities, escapes workflow-command
errors, restricts state paths to real workspace directories, and never returns
state or keys through outputs. Protect destructive recovery with an approval
boundary and grant only the permissions required by each operation.

See the [security policy](SECURITY.md) and [threat model](docs/threat-model.md)
for operational requirements and residual risks.

## Project status

The action is pre-`v1`; its API is not yet stable. It is not published in the
GitHub Marketplace. Consumers should pin a reviewed commit SHA. Stable `v1`
requires an API review and successful disposable integration coverage.

> [!NOTE]
> This project is maintained primarily for the organization's own use and
> shared as-is. It has no public support, roadmap, or response-time
> commitments. Forks are welcome for different workflows or priorities.

## Documentation

- [Architecture](docs/architecture.md)
- [Recovery and reset](docs/recovery.md)
- [Threat model](docs/threat-model.md)
- [Security policy](SECURITY.md)
- [Development and contributing](CONTRIBUTING.md)
