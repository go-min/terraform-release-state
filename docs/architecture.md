# Architecture

Terraform Release State is a Node.js 24 JavaScript action that manages one
Terraform state namespace in GitHub Release assets. The TypeScript `.mts`
source is bundled into the committed `dist/index.js`.

## Boundary

```text
consumer workflow
  restore -> verified local state + opaque remote marker
      -> Terraform init/plan/apply (consumer-owned)
  save    <- marker check -> backup -> replace -> verify -> retain

  reset   -> confirmation -> namespace audit -> assets -> Release -> tag
  import  -> verified state -> deterministic import proposal
```

The action owns Release API access, state transfer, integrity checks, backups,
retention, encryption, reset, and import proposals. The consumer owns
Terraform commands, workflow concurrency, cloud credentials, approvals, and
protected environments.

## Runtime components

| Component                       | Responsibility                                            |
| ------------------------------- | --------------------------------------------------------- |
| `config.mts`                    | Parse and validate the public action contract             |
| `github-api.mts`                | GitHub API calls, pagination, retries, and reconciliation |
| `state-manager.mts`             | Restore, save, consistency, verification, and recovery    |
| `backup-manager.mts`            | Backup pairs, compensation, orphan cleanup, retention     |
| `reset-core.mts`                | Fail-closed reset policy                                  |
| `encryption.mts`                | Native X25519 age encryption and decryption               |
| `state-files.mts`               | Workspace containment and secure local writes             |
| `imports.mts` / `import-pr.mts` | Import normalization, diff, and optional PR               |

## Guarantees

- Restore and import validate the remote state before use.
- Save rejects a changed remote marker and never uses silent last-write-wins.
- Backups have paired `.metadata.json` assets and bounded retention.
- Uploads are verified by downloading and hashing the resulting asset.
- Reset audits the managed namespace and treats `404` deletes as idempotent.
- Local state writes are workspace-contained and use restrictive permissions.

GitHub Release replacement is not atomic and does not provide backend-style
transactions or locking. Consumer workflows must serialize writers.

## Verification

Unit tests use the Node.js Native Test Runner with a mocked GitHub API.
Integration tests use disposable Release namespaces and cover bootstrap,
description, consistency conflicts, retention, encryption integrity,
recovery, and reset. Runtime behavior changes require rebuilding `dist`.
