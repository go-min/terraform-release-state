# Terraform Release State

An opinionated GitHub Action for protected Terraform state stored in a GitHub
Release. Zero configuration uses the current repository, `terraform-state`,
`terraform.tfstate`, plaintext unsigned bundles, and 20 backups. Optional age
encryption, Ed25519 signatures, and a separately chosen state Release restore
v0.4 capabilities without changing safe defaults.

The action never runs Terraform or exposes state values. The consumer owns
Terraform commands, credentials, approval, and a shared non-cancelling
concurrency group for writers.

## Public contract

| Input                                      | Default                                                     | Applies to                | Purpose                                                                                                |
| ------------------------------------------ | ----------------------------------------------------------- | ------------------------- | ------------------------------------------------------------------------------------------------------ |
| `operation`, `github-token`                | required                                                    | all                       | `restore`, `save`, `import`, or `reset`; GitHub token.                                                 |
| `state-repository`                         | current repository                                          | state operations          | Explicit `owner/name` Release storage location.                                                        |
| `release-tag`, `state-asset`, `state-path` | `terraform-state`, `terraform.tfstate`, `terraform.tfstate` | restore/save/reset/import | Namespace and workspace-relative local path.                                                           |
| `backup-retention`                         | `20`                                                        | save                      | Complete backup bundles retained after a successful save.                                              |
| `bootstrap`                                | `false`                                                     | restore                   | Permit creating absent storage. `TERRAFORM_BOOTSTRAP=true` is a deprecated fallback only when omitted. |
| `encryption`                               | `none`                                                      | state reads/writes        | `none` or `age`; age writes require `age-recipients`, reads require `age-identities`.                  |
| `signature-policy`                         | `allow-unsigned`                                            | state reads/writes        | `allow-unsigned` or `require`; signing and verification keys are optional secret inputs.               |
| `reset-target`                             | `all`                                                       | reset                     | Delete the named namespace or promote an exact backup.                                                 |
| `terraform-root`, `imports-path`           | `.`, `./imports.generated.tf`                               | import                    | Workspace-relative scan root and generated file.                                                       |
| `create-pr`, `pr-base`                     | `true`, default branch                                      | import                    | Create/update guarded proposal, or use `false` for read-only generation.                               |

`age-recipients`, `age-identities`, `signing-private-key`, and
`verification-public-keys` are secret inputs. Public signing keys use one
`ed25519:<base64url>` value per line, allowing rotation. Source commit and run
provenance are derived from GitHub context.

## Restore and save

Resolve `v0.6.0` to its verified immutable release commit and replace the placeholder below before use.

```yaml
permissions:
  contents: write
concurrency:
  group: terraform-state
  cancel-in-progress: false
steps:
  - uses: actions/checkout@<verified-commit-sha>
  - id: state-restore
    uses: go-min/terraform-release-state@<v0.6.0-release-commit-sha> # v0.6.0
    with:
      operation: restore
      github-token: ${{ github.token }}
  - working-directory: terraform
    run: terraform apply -input=false tfplan
  - if: ${{ always() && steps.state-restore.outcome == 'success' }}
    uses: go-min/terraform-release-state@<v0.6.0-release-commit-sha> # v0.6.0
    with:
      operation: save
      github-token: ${{ github.token }}
```

Restore verifies remote bytes and writes a repository-bound receipt under
`RUNNER_TEMP`. Save requires that receipt, validates each current and backup
bundle before mutation, uploads and downloads a verified safety backup, and
rechecks the receipt marker. It replaces current with the manifest last and
rolls back full verified bytes after partial failure. Once current is verified
it emits `state-write-committed=true` and its marker before maintenance.
Maintenance failure remains an action failure but leaves authoritative recovery
outputs.

For first use, only a protected restore may bootstrap:

```yaml
- uses: go-min/terraform-release-state@<v0.6.0-release-commit-sha> # v0.6.0
  with:
    operation: restore
    github-token: ${{ github.token }}
    bootstrap: true
```

## Encryption, signatures, and compatibility

Use `encryption: age` and `age-recipients` to save encrypted state. Reading,
saving over, or promoting encrypted state requires matching `age-identities`.
Write signed manifests with an unencrypted PKCS#8 Ed25519
`signing-private-key`; verification accepts one or more public keys. With
`signature-policy: require`, unsigned manifests fail closed.

v0.6 dual-reads legacy, v0.4 manifest, and v0.5 plaintext manifest bundles in
their existing Release namespace. Stored bytes and manifests are always
verified; plaintext is verified after decryption. Replacing encrypted or signed
current state requires the matching identity and signing private key, preventing
a verified rollback bundle from silent downgrade. No namespace is relocated and
no companion object is stripped.

## Import and reset

`operation: import` is read-only for state. It structurally scans
`terraform-root/**/*.tf`, suppresses targets declared outside `imports-path`,
and by default safely creates or updates a same-repository proposal PR. Set
`create-pr: false` for read-only generation. The branch inspection covers its
full merge-base diff, allows only the generated path, and uses a non-force
expected-SHA ref update.

`reset-target: all` is workflow-confirmed and deletes only the configured,
audited state namespace. An exact `state-asset.backup-*` target is fully
verified, creates a verified safety backup, rechecks both markers, promotes
with the manifest last, and rolls back partial replacement. The target remains
unchanged; promotion skips retention.

## Outputs and permissions

All prior marker, digest, lifecycle, reset, and import outputs remain
compatible. `state-sha256` remains plaintext SHA-256. `stored-state-sha256` is
the Release-byte SHA-256 and differs from `plaintext-state-sha256` for age
encryption. `signature-status` is `verified` or `unsigned`; its fingerprint is
set only after signature verification. Outputs never contain state, keys, or
plaintext values.

| Operation                                       | Required permissions                      |
| ----------------------------------------------- | ----------------------------------------- |
| Existing restore/import with `create-pr: false` | `contents: read`                          |
| Bootstrap restore, save, reset                  | `contents: write`                         |
| Import proposal                                 | `contents: write`, `pull-requests: write` |

Use a token authorized for `state-repository` when it differs from the workflow
repository; import PRs always remain in the workflow repository. See
[architecture](docs/architecture.md), [recovery](docs/recovery.md), and
[threat model](docs/threat-model.md).
