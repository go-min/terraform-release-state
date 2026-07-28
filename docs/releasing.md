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
2. Let Check and Security complete successfully for the pull request.
3. Merge the pull request into `main` using squash merge.
4. The release workflow runs disposable integration against the exact merged
   candidate SHA. Release Please cannot start before it passes, and a newer
   `main` update cancels the stale run before the integrated-head check.
5. Release Please opens or updates the release pull request.
6. Review the proposed version, `CHANGELOG.md`, `package.json`, and generated
   `dist/` changes.
7. Merge the release pull request after its checks pass.
8. The same exact-SHA integration gate runs for the release commit; only then
   can Release Please create the immutable SemVer tag and GitHub Release.

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

The stable tag identifies the intended release, but workflow examples should
pin its immutable release commit:

```yaml
uses: go-min/terraform-release-state@f7a3bc9bb80ceaf8b4bd554de1dbfc510358eee6 # v0.3.0
```

When upgrading, verify the tag and GitHub Release, replace the full SHA, and
keep the version in a comment for readability:

```yaml
uses: go-min/terraform-release-state@<verified-release-commit-sha> # vX.Y.Z
```

Stable `v1` requires a separate API review and successful integration coverage.
Until then, pre-`1.0.0` releases may change the public API.
