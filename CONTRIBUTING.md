# Contributing

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm typecheck`, `pnpm test`, and `pnpm format:check`.
3. Run `pnpm build` and commit the generated `dist/` bundle.
4. Keep state contents, credentials, and production Release assets out of tests.

Use disposable Release tags for integration tests. Do not publish a stable
version without API review and successful integration coverage.
