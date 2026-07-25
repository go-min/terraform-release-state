# Architecture

Terraform Release State is a Node.js 24 action that manages one Terraform state
namespace in a dedicated GitHub Release. It does not execute Terraform or
provide workflow locking.

## System boundary

```text
consumer workflow
  restore ──> verified local state + opaque remote marker
      │
      └────> Terraform execution (consumer-owned)
                  │
  save <──────────┘ marker check -> backup -> replace -> verify -> retain

  reset ──> confirmation -> namespace audit -> assets -> Release -> tag
```

The consumer owns Terraform commands, cloud credentials, concurrency,
approvals, and environments. The action owns Release lookup, state transfer,
integrity, backups, retention, encryption, and reset.

## Components

| Component            | Responsibility                                              |
| -------------------- | ----------------------------------------------------------- |
| `config.mts`         | Parse and validate the action contract                      |
| `github-api.mts`     | GitHub Release API, pagination, retries, and reconciliation |
| `state-manager.mts`  | Restore, save, consistency, verification, and recovery      |
| `backup-manager.mts` | Backup pairs, compensation, orphan cleanup, and retention   |
| `reset-core.mts`     | Fail-closed reset policy independent of the API adapter     |
| `encryption.mts`     | Native X25519 age encryption and decryption                 |
| `state-files.mts`    | Workspace containment and secure atomic local writes        |
| `main.mts`           | Runtime dispatch                                            |

The TypeScript `.mts` source is bundled into committed `dist/index.js` for a
dependency-free consumer experience. Runtime packages are limited to
`@actions/github` and `age-encryption`.

## Consistency and integrity

Restore returns an opaque marker containing the remote asset identity. Save
requires that marker for an existing state and checks it before replacement and
again after backup creation. A changed, missing, or newly appeared asset aborts
the operation.

Downloads are checked against GitHub's digest when available. Current state
uploads are downloaded and hashed before success is reported. Encrypted state
adds versioned metadata bound to the ciphertext checksum.

## Failure handling

- Idempotent reads and deletes retry transient `5xx` and rate-limit `403`/`429`
  responses with bounded delays and GitHub rate-limit headers.
- Permission `403` responses are not retried or treated as missing state.
- Create and upload requests are not blindly repeated. After an ambiguous
  failure, the action accepts only an existing resource with expected content.
- Delete `404` responses are idempotent success.
- Replacement failure triggers guarded recovery of the previous state.
- Backup and metadata assets are managed as pairs. Partial creation is
  compensated; retention removes orphans and deletes metadata first so retries
  remain safe.

Release asset replacement is not atomic. The paired backup and guarded recovery
path reduce risk but do not provide backend-style transactions.

## Verification

Unit tests use the Node.js native test runner and mock the GitHub API. The
disposable integration workflow uses a unique Release tag, covers the live API
contract, and performs native reset in an `always()` cleanup step. It runs after
every push to `main` and can also be started manually.
