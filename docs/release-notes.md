# Release notes

## Next release

- Fix StateImport IDs for GitHub provider resources:
  - `github_repository_ruleset` now uses `<repository>:<ruleset_id>`.
  - `github_repository_vulnerability_alerts` now uses `<repository>`.
- Skip provider-specific resources when the required `repository` attribute is
  absent instead of guessing an import ID.
- Use `terraform-release-state/<imports-filename>` for the default generated
  pull request branch.
