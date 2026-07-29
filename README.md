# Terraform Release State

[![Check](https://github.com/go-min/terraform-release-state/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/go-min/terraform-release-state/actions/workflows/check.yml)
[![Release candidate integration](https://github.com/go-min/terraform-release-state/actions/workflows/integration.yml/badge.svg?branch=main)](https://github.com/go-min/terraform-release-state/actions/workflows/integration.yml)
[![Security](https://github.com/go-min/terraform-release-state/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/go-min/terraform-release-state/actions/workflows/security.yml)
[![Node.js 24](https://img.shields.io/badge/runtime-Node.js%2024-339933?logo=nodedotjs&logoColor=white)](action.yml)

An opinionated GitHub Action for the protected `go-min` same-repository
Terraform-state protocol. It stores one plaintext unsigned state in a fixed
GitHub Release namespace, verifies every write, retains recovery backups, and
refuses stale or unsupported mutations.

This is not a generic Terraform backend. It does not run Terraform, apply
infrastructure, provide backend locking, accept cross-repository storage, or
expose state values.

## Fixed protocol

| Item                         | Value                                |
| ---------------------------- | ------------------------------------ |
| Repository                   | `github.context.repo`                |
| Release tag                  | `terraform-state`                    |
| Current state and local path | repository-root `terraform.tfstate`  |
| Current manifest             | `terraform.tfstate.manifest.json`    |
| Backups                      | `terraform.tfstate.backup-*` bundles |
| Retention                    | 20 complete backups                  |
| Terraform configuration root | `terraform`                          |
| Generated imports            | `terraform/imports.generated.tf`     |
| Import PR base               | `main`                               |
| Storage policy               | plaintext and unsigned               |

The consumer workflow owns Terraform execution, cloud credentials, protected
environments, and one shared non-cancelling concurrency group for every state
writer.

## Public inputs

| Input          | Required | Description                                                    |
| -------------- | -------: | -------------------------------------------------------------- |
| `operation`    |      yes | `restore`, `save`, `import`, or `reset`                        |
| `github-token` |      yes | Token for the current repository                               |
| `reset-target` |       no | `all` or an exact backup state name; reset only, default `all` |

There are no public repository, path, tag, asset, retention, bootstrap,
provenance, import, encryption, signing, or consistency-marker inputs.

## Restore and save

The Terraform configuration under `terraform` must use the repository-root
state path, for example a local backend path of `../terraform.tfstate`.

Resolve the published `v0.5.0` tag to its verified immutable release commit and
replace `<v0.5.0-release-commit-sha>` below before use.

```yaml
permissions:
  contents: write

concurrency:
  group: terraform-state
  cancel-in-progress: false

steps:
  - uses: actions/checkout@<verified-commit-sha>

  - name: Restore state
    id: state-restore
    uses: go-min/terraform-release-state@<v0.5.0-release-commit-sha> # v0.5.0
    with:
      operation: restore
      github-token: ${{ github.token }}

  - name: Apply reviewed Terraform plan
    working-directory: terraform
    run: terraform apply -input=false tfplan

  - name: Save authoritative local state
    if: ${{ always() && steps.state-restore.outcome == 'success' }}
    uses: go-min/terraform-release-state@<v0.5.0-release-commit-sha> # v0.5.0
    with:
      operation: save
      github-token: ${{ github.token }}
```

Restore validates the current bundle, writes `terraform.tfstate` with
restrictive permissions, and writes a repository-bound opaque receipt beneath
`RUNNER_TEMP`. Save requires that receipt from a successful restore in the same
job and compares its marker immediately before mutation. Callers cannot supply
or override the marker.

Save validates every managed current and backup bundle before the first remote
mutation. It then uploads and downloads a verified safety backup, rechecks the
current bundle, replaces current state with manifest last, downloads and
verifies it, updates the receipt, and enforces retention 20. Partial replacement
rolls back to the previously verified bytes.

Once the new current state is verified, `state-write-committed=true` and its
new `remote-state-marker` are emitted before receipt/retention maintenance. A
maintenance failure still fails the step with recovery guidance while keeping
the committed marker available.

### Protected bootstrap

Missing storage fails closed unless the protected workflow sets the exact
environment boundary:

```yaml
env:
  TERRAFORM_BOOTSTRAP: "true"

steps:
  - uses: go-min/terraform-release-state@<v0.5.0-release-commit-sha> # v0.5.0
    with:
      operation: restore
      github-token: ${{ github.token }}
```

Only restore may create the missing Release. Bootstrap creates no state and no
infrastructure; it records an absent-state receipt for the first save. Existing
Release restore and import make zero create/update Release calls.

## Import proposal

`operation: import` reads and validates Release state without writing a local
state file. It structurally scans `terraform/**/*.tf`, suppresses targets
already declared outside `terraform/imports.generated.tf`, and creates or
updates the fixed same-repository PR safely.

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - uses: actions/checkout@<verified-commit-sha>
  - uses: go-min/terraform-release-state@<v0.5.0-release-commit-sha> # v0.5.0
    with:
      operation: import
      github-token: ${{ github.token }}
```

The action inspects the complete automation-branch diff, permits only the
generated path, preserves current `main` as an ancestor during stale-branch
refresh, and uses expected-head/non-force ref updates. It never runs
`terraform apply` or logs state.

## Reset and recovery

Reset confirmation is workflow-owned. Protect the existing reset workflow with
its exact `RESET` dispatch confirmation and protected environment before
calling the action.

```yaml
- name: Reset or promote approved state
  if: ${{ inputs.confirmation == 'RESET' }}
  uses: go-min/terraform-release-state@<v0.5.0-release-commit-sha> # v0.5.0
  with:
    operation: reset
    github-token: ${{ github.token }}
    reset-target: ${{ inputs.reset_target || 'all' }}
```

- `all` audits the owned namespace and deletes its assets, Release, and tag.
- An exact `terraform.tfstate.backup-*` name downloads and verifies the target,
  creates a verified safety backup of current state, rechecks current and target
  markers, promotes state with manifest last, and verifies the result.
- The selected backup remains unchanged. A partial promotion restores the full
  previous current bundle; if none existed, no partial current object remains.
- Promotion does not run retention. The next save enforces the fixed limit.

See [recovery](docs/recovery.md) before resetting or promoting a backup.

## v0.4 migration boundary

v0.5 reads legacy plaintext state and unsigned plaintext v0.4 manifest bundles.
It does not accept age encryption or Ed25519 signatures. If any encrypted or
signed managed object is encountered before a mutation, the action fails with
`TRS_V04_MIGRATION_REQUIRED`.

Pin v0.4.0 at
`fb529572e17d20c414afacc7a7e14ffa0033058d`, restore and verify using the
original age identities or verification keys, then save or reset into plaintext
unsigned storage before upgrading. v0.5 never decrypts, strips a signature, or
relocates a namespace implicitly.

## Outputs

Existing marker, digest, verification, warning, lifecycle, backup, reset, and
import outputs remain available. In particular:

- `state-sha256` retains its plaintext SHA-256 meaning.
- `stored-state-sha256` and `plaintext-state-sha256` are equal for v0.5 writes.
- `signature-status` is `unsigned`; the fingerprint is unset.
- `state-write-committed`, `state-phase`, and `state-status` distinguish commit
  from maintenance.
- `reset-action`, `reset-target`, and `reset-promoted-marker` describe reset.
- Import exposes candidate, skipped, collision counts, PR action, and PR URL.

No output contains Terraform state, outputs, credentials, or private values.

## Permissions

| Operation           | Required permissions                      |
| ------------------- | ----------------------------------------- |
| Existing `restore`  | `contents: read`                          |
| Bootstrap `restore` | `contents: write`                         |
| `save` / `reset`    | `contents: write`                         |
| `import`            | `contents: write`, `pull-requests: write` |

Use a protected workflow and the repository `GITHUB_TOKEN`; v0.5 deliberately
does not support cross-repository credentials or storage.
