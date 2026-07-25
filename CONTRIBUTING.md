# Contributing

> [!IMPORTANT]
> This project is maintained primarily for the organization's own use.
>
> - It is not actively seeking public contributions.
> - There is no review or merge timeline.
> - Forks are welcome for different workflows or priorities.

1. Run `pnpm install --frozen-lockfile`.
2. Run `pnpm typecheck`, `pnpm test`, `pnpm format:check`, and `pnpm lint`.
3. Run `pnpm build` and commit the generated `dist/` bundle.
4. Keep state contents, credentials, and production Release assets out of tests.

Use disposable Release tags for integration tests. Do not publish a stable
version without API review and successful integration coverage.
