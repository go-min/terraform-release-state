# Terraform Release State

[![Check](https://github.com/go-min/terraform-release-state/actions/workflows/check.yml/badge.svg?branch=main)](https://github.com/go-min/terraform-release-state/actions/workflows/check.yml)
[![Disposable integration](https://github.com/go-min/terraform-release-state/actions/workflows/integration.yml/badge.svg?branch=main)](https://github.com/go-min/terraform-release-state/actions/workflows/integration.yml)
[![Security](https://github.com/go-min/terraform-release-state/actions/workflows/security.yml/badge.svg?branch=main)](https://github.com/go-min/terraform-release-state/actions/workflows/security.yml)
[![Release Please](https://github.com/go-min/terraform-release-state/actions/workflows/release-please.yml/badge.svg?branch=main)](https://github.com/go-min/terraform-release-state/actions/workflows/release-please.yml)
[![Node.js 24](https://img.shields.io/badge/runtime-Node.js%2024-339933?logo=nodedotjs&logoColor=white)](action.yml)
[![MIT license](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)

Store, restore, verify, encrypt, and back up Terraform state using GitHub
Release assets.

> [!IMPORTANT]
> This action is not a native Terraform backend. It does not provide locking
> or run Terraform. The consumer workflow owns Terraform execution,
> concurrency, credentials, approvals, and protected environments.
>
> **Project status.** This project is maintained primarily for the
> organization's own use and is shared as-is. It has no public support,
> roadmap, or response-time commitments. Forks are welcome for different
> workflows or priorities.

## Recommended setup

Use one shared concurrency group for every workflow that can write the same
state asset. Restore before Terraform runs, keep the restore marker, and save
with `always()` after Terraform so a partially successful apply is persisted.

The example below uses the default storage namespace:

- repository: the current repository;
- Release tag: `terraform-state`;
- current asset: `terraform.tfstate`.

```yaml
permissions:
  contents: write

concurrency:
  group: terraform-state
  cancel-in-progress: false

steps:
  - uses: actions/checkout@<commit-sha>

  - name: Restore Terraform state
    id: state-restore
    uses: go-min/terraform-release-state@f7a3bc9bb80ceaf8b4bd554de1dbfc510358eee6 # v0.3.0
    with:
      operation: restore
      github-token: ${{ github.token }}
      state-path: terraform.tfstate

  - name: Terraform apply
    run: terraform apply -input=false tfplan

  - name: Save Terraform state
    if: ${{ always() && steps.state-restore.outcome == 'success' }}
    uses: go-min/terraform-release-state@f7a3bc9bb80ceaf8b4bd554de1dbfc510358eee6 # v0.3.0
    with:
      operation: save
      github-token: ${{ github.token }}
      state-path: terraform.tfstate
      expected-remote-state-marker: ${{ steps.state-restore.outputs.remote-state-marker }}
```

For a different state repository, use `state-repository: owner/name` and a
short-lived GitHub App installation token with the minimum permissions listed
below. Do not use a classic PAT as the primary production credential.

## Operations

| Operation | Purpose                                       |        Writes state? |
| --------- | --------------------------------------------- | -------------------: |
| `restore` | Download and validate the current state       | Local workspace only |
| `save`    | Back up, replace, verify, and retain state    |                  Yes |
| `reset`   | Explicitly delete one managed state namespace |                  Yes |
| `import`  | Generate and review Terraform import blocks   |        No by default |

### Restore and bootstrap

`restore` fails closed when the Release, current asset, metadata, or integrity
checks are invalid. A missing namespace is not treated as an access error.
For existing storage, restore is read-only and preserves the Release name,
body, and other operator-managed metadata. Contents write is needed only when
explicit bootstrap must create missing storage.

Use `bootstrap: "true"` only for first-time setup or an approved recovery:

```yaml
with:
  operation: restore
  bootstrap: "true"
  github-token: ${{ github.token }}
  state-path: terraform.tfstate
```

Bootstrap creates the empty storage boundary. It does not run Terraform,
import resources, or create infrastructure.

### Save and consistency

For an existing state, `save` requires the opaque marker returned by
`restore`. Before replacing the current asset it verifies that the remote state
has not changed, creates a backup pair, downloads and cryptographically verifies
both newly uploaded backup objects, uploads the new state, downloads it for
verification, and applies retention. A concurrent or manual change fails the
save instead of using last-write-wins. The existing current state is not deleted
until its newly uploaded backup pair has passed verification.

The verified replacement is the commit boundary. If later retention or orphan
cleanup fails, the action still fails, but `state-write-committed` is `true`,
`state-phase` is `maintenance`, `state-status` is `maintenance-failed`, and the
new `remote-state-marker` identifies the authoritative state. Restore again
before a later save and handle cleanup as a separate recovery task.

Release asset replacement is not atomic. Guarded recovery and backups reduce
risk but do not provide backend-style transactions.

### Reset

Reset requires the exact `confirmation: RESET`. It audits the target Release
and deletes only the configured current asset, metadata, backups, Release, and
tag. Unexpected assets stop the operation before Release deletion. Missing
resources are already-reset success, so a partial reset can be retried.

See [Recovery and reset](docs/recovery.md).

## Terraform import proposals

`operation: import` reads the current state from Release storage, validates it
like `restore`, and proposes deterministic import blocks. It never creates a
local state file, runs Terraform, modifies state, or returns state through an
output.

Default mode prints a diff only:

```yaml
- name: Review Terraform imports
  uses: go-min/terraform-release-state@f7a3bc9bb80ceaf8b4bd554de1dbfc510358eee6 # v0.3.0
  with:
    operation: import
    github-token: ${{ github.token }}
    imports-path: terraform/imports.generated.tf
```

To create or update a pull request, grant `contents: write` and
`pull-requests: write`, then set `create-pr: "true"`:

```yaml
permissions:
  contents: write
  pull-requests: write

steps:
  - name: Propose Terraform imports
    uses: go-min/terraform-release-state@f7a3bc9bb80ceaf8b4bd554de1dbfc510358eee6 # v0.3.0
    with:
      operation: import
      github-token: ${{ github.token }}
      terraform-root: terraform
      imports-path: terraform/imports.generated.tf
      create-pr: "true"
      pr-base: main
```

The default PR branch is
`terraform-release-state/<imports-filename>`. The proposal workflow changes
only the configured imports file and refuses to overwrite unrelated branch
changes. It inspects the complete branch change set against the merge base, not
just the generated file contents. A stale action-only branch is rebuilt from the
latest base tree with both the observed branch head and current base as parents,
then advanced without force after an expected-head check. This keeps the base as
an ancestor for a correct PR diff while failing closed on concurrent updates.

Before rendering, the action scans `.tf` files recursively below
`terraform-root` (default `.`), excluding `imports-path`, `.git`, `.terraform`,
and `node_modules`. A small structural HCL lexer/parser reads top-level
`import` blocks and their `to` expressions; matching targets are suppressed
rather than duplicated. Malformed import blocks, truncated repository trees,
symbolic links in the scanned configuration, and unrelated automation-branch
changes stop the operation instead of being guessed around.

`terraform-root` must be a real directory whose lexical and resolved paths stay
inside `GITHUB_WORKSPACE`; symlink roots and symlink path components are
rejected. PR mode never reads the workspace copy of `imports-path`: its diff is
based on the remote base branch. Diff-only mode reads `imports-path` only when
it exists as a regular, non-symlink file with the same workspace containment.

When generated content already matches the base, PR mode returns `unchanged`.
If an open PR on the configured branch changes only the generated file, it is
closed as obsolete and returns `closed`. Its branch is retained because the
GitHub ref deletion API has no expected-SHA guard.
Review every target and the resulting Terraform plan before merging.

Import proposals use explicit provider-specific normalization, not a general
provider-aware import planner:

| Resource                                 | Generated import ID         | Required state attributes |
| ---------------------------------------- | --------------------------- | ------------------------- |
| `github_repository_ruleset`              | `<repository>:<ruleset_id>` | `repository`, `id`        |
| `github_repository_vulnerability_alerts` | `<repository>`              | `repository`              |
| Other resources                          | `attributes.id` unchanged   | `id`                      |

If a required provider-specific attribute is absent, the resource is skipped
with a reason. The action does not infer repository names from numeric IDs or
other state fields.

## Encryption

Set `encryption: age` to store ciphertext while Terraform uses the plaintext
file at `state-path`:

```yaml
# restore
encryption: age
age-identities: ${{ secrets.TF_STATE_AGE_IDENTITIES }}

# save
encryption: age
age-recipients: ${{ vars.TF_STATE_AGE_RECIPIENTS }}
```

Only native X25519 `age1...` recipients and `AGE-SECRET-KEY-1...` identities
are supported. Passphrases, SSH keys, plugins, and automatic plain/encrypted
migrations are not supported. Retain old identities until all backups
encrypted for them are outside the retention window.

## Permissions and authentication

| Operation                | Required permission in the state repository                                                      |
| ------------------------ | ------------------------------------------------------------------------------------------------ |
| `restore` / `import`     | Contents: read                                                                                   |
| `restore` with bootstrap | Contents: write                                                                                  |
| `save` / `reset`         | Contents: write                                                                                  |
| `import` with PR         | Contents: read for state and Contents: write plus Pull requests: write for the target repository |

The default `GITHUB_TOKEN` can access the current repository. Cross-repository
storage and PR creation normally require a GitHub App installation token with
access to both repositories. Keep tokens, age identities, and plaintext state
out of logs, outputs, artifacts, and caches.

## Inputs

| Input                                | Default                  | Notes                                   |
| ------------------------------------ | ------------------------ | --------------------------------------- |
| `operation`                          | required                 | `restore`, `save`, `reset`, or `import` |
| `github-token`                       | required                 | Token for the state repository          |
| `state-repository`                   | current repository       | `owner/name`                            |
| `release-tag`                        | `terraform-state`        | Managed Release tag                     |
| `state-asset`                        | `terraform.tfstate`      | Current state asset                     |
| `state-path`                         | —                        | Required for `restore` and `save`       |
| `bootstrap`                          | `false`                  | Explicit missing-storage creation       |
| `expected-remote-state-marker`       | —                        | Required by `save` for existing state   |
| `backup-retention`                   | `20`                     | Complete backup pairs, `0`–`1000`       |
| `confirmation`                       | —                        | Must be `RESET` for `reset`             |
| `encryption`                         | `none`                   | `none` or `age`                         |
| `age-recipients` / `age-identities`  | —                        | Encryption key material                 |
| `imports-path`                       | `./imports.generated.tf` | Import proposal output path             |
| `terraform-root`                     | `.`                      | Recursive `.tf` duplicate-target scan   |
| `create-pr`                          | `false`                  | Enable import proposal PR mode          |
| `pr-base` / `pr-branch` / `pr-title` | derived                  | Import proposal PR settings             |

`source-commit` and `workflow-run-id` default to the matching GitHub Actions
context values and are recorded in backup metadata.

## Outputs

Outputs contain only identifiers, checksums, counts, and the opaque remote
marker. The action never returns Terraform state, credentials, keys, or other
secret content. `state-sha256` remains the plaintext checksum for compatibility,
while `plaintext-state-sha256` names that meaning explicitly.
`stored-state-sha256` hashes the exact uploaded/downloaded Release bytes, so it
differs from the plaintext checksum when age encryption is enabled.
`state-digest` remains GitHub's reported stored-asset digest when GitHub supplies
one; it is not silently redefined as either new checksum output. See `action.yml`
for the complete output list.

Import operations additionally return `import-candidate-count` (rendered
blocks after collision suppression), `import-skipped-count` (all excluded
resources, including collisions), `import-collision-count` (the collision
subset), and `import-pr-action` (`disabled`, `created`, `updated`, `unchanged`,
or `closed`). `import-pr-url` remains available when a PR was created, updated,
or closed.

## Limitations and release status

- GitHub Releases do not provide native Terraform locking or transactions.
- Plain state may contain secrets; repository access is part of the security
  boundary.
- A lost age identity makes matching encrypted state unrecoverable.
- A compromised runner can access plaintext state supplied to Terraform.
- Marketplace publication is not enabled. The current immutable release pin is
  `f7a3bc9bb80ceaf8b4bd554de1dbfc510358eee6` (`v0.3.0`).
- For stronger supply-chain protection, pin the full immutable commit SHA from
  the release and keep the version in a comment.
- Releases are prepared by a reviewed Release PR. After each `main` update,
  publication automation waits for disposable integration against that exact
  candidate SHA before Release Please can create a PR or publish a release.

See the [release process](docs/releasing.md) for maintainer instructions and
the [changelog](CHANGELOG.md) for the release history.

Release automation uses the GitHub Environment `release-please`. Configure its
variables and secrets as follows:

- variable `RELEASE_APP_CLIENT_ID` — GitHub App client ID;
- secret `RELEASE_APP_PRIVATE_KEY` — GitHub App private key.

The App must be installed on this repository with Contents and Pull requests
write access. A short-lived installation token is used so the Release PR
receives normal CI checks. Classic PATs are not the recommended release
credential.

See [Architecture](docs/architecture.md), [Recovery](docs/recovery.md), and
the [Threat model](docs/threat-model.md) for implementation boundaries and
operational detail.
