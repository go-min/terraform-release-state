# Release process

Releases are prepared by Release Please and published from `main`. The
repository uses the Node release strategy, so `package.json`, the manifest,
the changelog, the immutable tag, and the GitHub Release must stay aligned.

## Commit and pull request titles

Use Conventional Commits for pull request titles because the repository uses
the default Release Please commit parser:

| Prefix                                                   | Effect before `1.0.0`            |
| -------------------------------------------------------- | -------------------------------- |
| `feat:`                                                  | Minor release                    |
| `fix:`, `perf:`                                          | Patch release                    |
| `docs:`, `chore:`, `ci:`, `test:`, `refactor:`, `build:` | No release by default            |
| `feat!:` or a `BREAKING CHANGE:` footer                  | Breaking-change release handling |

Examples:

```text
feat: add encrypted state restore
fix: reject stale metadata during save
docs: clarify cross-repository permissions
```

Because `main` is protected with squash merges, use the pull request title as
the final Conventional Commit message. Do not use free-form titles such as
`update stuff` for changes that should appear in a release.

## Normal release flow

1. Open a pull request with a Conventional Commit title.
2. Let Check, Security, and Disposable integration complete successfully.
3. Merge the pull request into `main` using squash merge.
4. Release Please opens or updates the release pull request on the next push
   to `main`.
5. Review the proposed version, `CHANGELOG.md`, `package.json`, and generated
   `dist/` changes.
6. Merge the release pull request after its checks pass.
7. Release Please creates the immutable SemVer tag and GitHub Release.

The release workflow uses a short-lived GitHub App installation token from the
`release-please` environment. It does not use a classic PAT as the primary
credential.

## Before merging a release pull request

Run the local checks required by CI:

```bash
pnpm typecheck
pnpm test
pnpm format:check
pnpm lint
pnpm build
```

Confirm that `dist/` is synchronized with `src/`, `package.json` has the
proposed version, and the changelog contains only the intended release notes.
Do not manually create or move a stable release tag as part of the normal
flow.

## Version selection

Consumers should use the stable version tag from the intended release:

```yaml
uses: go-min/terraform-release-state@v0.2.1
```

For stronger supply-chain protection, pin the full immutable commit SHA from
the release instead and keep the version in a comment:

```yaml
uses: go-min/terraform-release-state@<release-commit-sha> # v0.2.1
```

Stable `v1` requires a separate API review and successful integration coverage.
Until then, pre-`1.0.0` releases may change the public API.
