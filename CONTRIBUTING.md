# Contributing

This project is maintained primarily for the `go-min` protected Terraform
workflow. Forks are welcome, but the action is intentionally opinionated rather
than a generic Terraform backend.

## Development

Use Node.js 24 and the pinned pnpm toolchain without bypassing the workspace
supply-chain policy.

```bash
pnpm install --frozen-lockfile --ignore-scripts
pnpm format:check
pnpm lint
pnpm audit --audit-level high
pnpm typecheck
pnpm test
pnpm build
git diff --exit-code -- dist
git diff --check
```

Source uses TypeScript `.mts`, the Node.js native test runner, Biome, and
Prettier. Runtime changes must include a reproducibly rebuilt `dist/index.js`.

## Change requirements

- Keep the documented default-first public input contract backward-compatible.
- Preserve zero-config defaults while validating every optional namespace and path override.
- Preserve read-only existing restore/import behavior.
- Preserve receipt-based optimistic consistency and fail-closed bootstrap.
- Verify every new backup/current upload before it is accepted.
- Upload manifests last and fault-test every replacement rollback stage.
- Never log/output state, credentials, tokens, or Terraform values.
- Keep import generation safe for the configured workspace paths and protect its branch with
  full-diff and expected-SHA checks.
- Keep package and lockfile changes synchronized.
- Update public API, architecture, recovery, threat, and release documentation.

Reset confirmation remains workflow-owned. Do not add it back as an action
input. Release-candidate integration keeps the deterministic local GitHub API
fixture for fault injection, then exercises a disposable live Release namespace
only after proving it absent and atomically claiming its tag at the
exact candidate SHA. Cleanup is ownership-guarded and must leave both the
Release and tag absent.

Use Conventional Commit titles. Release Please owns version, changelog, tag,
and GitHub Release creation; do not manually create or move release tags.
