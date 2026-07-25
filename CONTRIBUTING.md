# Contributing

1. Run `npm ci`.
2. Run `npm run typecheck`, `npm test`, and `npm run format:check`.
3. Run `npm run build` and commit the generated `dist/` bundle.
4. Keep state contents, credentials, and production Release assets out of tests.

Use disposable Release tags for integration tests. Do not publish a stable
version without API review and successful integration coverage.
