# Contributing

This project is maintained primarily for the `go-min` protected Terraform
workflow. Forks are welcome, but v0.5 intentionally does not offer generic
repository, path, encryption, signing, or retention configuration.

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

- Keep public inputs exactly `operation`, `github-token`, and `reset-target`.
- Preserve the fixed same-repository namespace and root `terraform.tfstate`.
- Preserve read-only existing restore/import behavior.
- Preserve receipt-based optimistic consistency and fail-closed bootstrap.
- Verify every new backup/current upload before it is accepted.
- Upload manifests last and fault-test every replacement rollback stage.
- Never log/output state, credentials, tokens, or Terraform values.
- Keep import generation fixed under `terraform` and protect its branch with
  full-diff and expected-SHA checks.
- Keep package and lockfile changes synchronized.
- Update public API, architecture, recovery, threat, and release documentation.

Reset confirmation remains workflow-owned. Do not add it back as an action
input. Release-candidate integration keeps the deterministic local GitHub API
fixture for fault injection, then exercises the fixed live `terraform-state`
namespace only after proving it absent and atomically claiming its tag at the
exact candidate SHA. Cleanup is ownership-guarded and must leave both the
Release and tag absent.

Use Conventional Commit titles. Release Please owns version, changelog, tag,
and GitHub Release creation; do not manually create or move release tags.
