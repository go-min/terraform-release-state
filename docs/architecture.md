# Architecture

Terraform Release State v0.5 is a Node.js 24 JavaScript action implementing one
fixed same-repository state protocol. TypeScript `.mts` source is compiled and
bundled into committed `dist/index.js`.

## Boundary

```text
protected workflow
  restore -> verify remote -> repository-root terraform.tfstate
          -> protected RUNNER_TEMP receipt
  Terraform plan/apply (consumer-owned, configuration under terraform)
  save    -> receipt CAS -> verified backup -> replace -> verify -> retain 20

  import  -> verify remote -> structural scan -> safe fixed-path PR
  reset all    -> namespace audit -> Release/tag deletion
  reset backup -> verify -> safety backup -> CAS -> promote -> verify/rollback
```

The repository, Release tag, current asset, local path, backup retention,
Terraform root, imports path, PR base, and PR branch are protocol constants.
The action derives repository and provenance from GitHub context. The consumer
owns Terraform commands, credentials, concurrency, approval, and workflow-level
reset confirmation.

## Runtime components

| Component                       | Responsibility                                                |
| ------------------------------- | ------------------------------------------------------------- |
| `protocol.mts`                  | Fixed v0.5 constants and migration guidance                   |
| `config.mts`                    | Three-input action boundary and GitHub environment derivation |
| `receipt.mts`                   | Repository-bound restore receipt under `RUNNER_TEMP`          |
| `github-api.mts`                | GitHub API pagination, bounded retries, and reconciliation    |
| `manifest.mts`                  | Strict v1 schema and canonical serialization                  |
| `state-bundle.mts`              | Legacy/v0.4 classification, verification, and migration gate  |
| `state-manager.mts`             | Restore, save, optimistic consistency, and rollback           |
| `backup-manager.mts`            | Verified backup creation, compensation, and retention         |
| `reset.mts` / `reset-core.mts`  | Full reset and exact-backup promotion                         |
| `terraform-config.mts`          | Structural import-target scanner                              |
| `imports.mts` / `import-pr.mts` | Fixed proposal and protected PR branch refresh                |
| `state-files.mts`               | Symlink-safe workspace reads and writes                       |
| `errors.mts`                    | Stable machine-readable failures                              |

## Storage layout

Current state consists of:

```text
terraform.tfstate
terraform.tfstate.manifest.json
```

Each backup consists of:

```text
terraform.tfstate.backup-<timestamp>-<run>-<uuid>
terraform.tfstate.backup-<...>.metadata.json
terraform.tfstate.backup-<...>.manifest.json
```

The compatibility metadata binds a backup to `terraform.tfstate` and its
stored digest. The canonical manifest binds object role/name, stored and
plaintext SHA-256 and size, Terraform version/serial/lineage when parseable,
parent marker/digest, plaintext encryption mode, and GitHub provenance.
Lineage is an infrastructure correlation identifier, not a secret or state
value.

Manifests use schema-owned field order, two-space JSON indentation, UTF-8, and
one trailing line feed. Readers strictly validate and reserialize for byte
equality. The manifest is uploaded last and is the flat-bundle completion
signal.

## Consistency and recovery

Restore writes a receipt containing the exact observed state marker. It is
bound to repository, Release tag, and asset name, stored as a regular mode-0600
file, and cannot be supplied through action inputs. Save requires the receipt
and fails if current state appeared, disappeared, or changed.

Before mutation, save verifies every complete managed bundle and rejects any
encrypted or signed object. It then verifies a new safety backup, repeats its
current-bundle comparison, deletes/replaces current state, and downloads the
replacement. Failure removes only observed replacement objects and restores
the previously verified bytes with manifest last.

Once replacement verification succeeds, the new marker is authoritative.
Receipt update and retention are post-commit maintenance; their failure leaves
machine-readable committed state and recovery guidance while failing the step.

Exact-backup reset uses the same rules. It keeps the selected backup, creates a
new safety backup when current exists, compares both observed bundles before
replacement, promotes with a new current manifest, and fully rolls back partial
replacement. Promotion deliberately skips retention.

GitHub Release replacement is not a transactional Terraform backend and GitHub
does not provide locking. Protected workflows must serialize all writers.

## Import branch graph safety

Import always targets `terraform/imports.generated.tf` on a fixed action-owned
branch against `main`. The action compares complete recursive trees from the
merge base and permits only that path.

A stale branch is rebuilt with the latest-base-plus-generated tree and parents
`[observed branch head, current base SHA]`. The observed head preserves
fast-forward race safety; the second parent makes current base an ancestor so
the pull request does not replay already-merged base changes. The ref update
rechecks the expected SHA and uses `force: false`.

## Compatibility

v0.5 dual-reads legacy plaintext and unsigned plaintext manifest-v1 storage.
Age ciphertext, age metadata, and detached signature assets produce
`TRS_V04_MIGRATION_REQUIRED` before mutation. The action contains no age runtime
or signing key path and performs no implicit downgrade or relocation.
