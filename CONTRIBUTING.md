# Contributing

> [!IMPORTANT]
> This project is maintained primarily for the organization's own use.
>
> - It is not actively seeking public contributions.
> - There is no review or merge timeline.
> - Forks are welcome for different workflows or priorities.

## Development

```bash
pnpm install --frozen-lockfile
pnpm typecheck
pnpm test
pnpm format:check
pnpm lint
pnpm build
```

Use Node.js 24, TypeScript `.mts`, the Node.js native test runner, and Biome. Do
not add a test framework. Commit the generated `dist/` bundle whenever source
changes affect runtime behavior.

## Change requirements

- Preserve optimistic consistency and fail-closed bootstrap behavior.
- Never log or output state, credentials, tokens, or private keys.
- Keep state paths workspace-relative and backup metadata in `.metadata.json`.
- Pin dependency changes in both `package.json` and `pnpm-lock.yaml`.
- Use disposable Release tags for integration tests and always clean them up.
- Document public API, state format, encryption, and recovery changes.

Release, publication, and production integration changes require explicit
maintainer approval. Use Conventional Commit prefixes (`feat:`, `fix:`,
`docs:`, `chore:`, `refactor:`, `test:`, `ci:`, or `build:`). After changes
reach `main`, release-please creates or updates a Release PR with the version,
`package.json`, and `CHANGELOG.md` changes. Merge that PR only after its normal
checks pass; release-please then creates the GitHub Release and tag.

Release automation uses the `release-please` GitHub Environment and a
short-lived GitHub App installation token configured through its
`RELEASE_APP_CLIENT_ID` variable and `RELEASE_APP_PRIVATE_KEY` secret. Do not
publish a release by manually creating or moving tags.
