# Security policy

## Reporting a vulnerability

Do not open a public issue. Contact the organization owner through a trusted
private channel, or use GitHub private vulnerability reporting when it is
available in the repository Security tab. Include reproduction steps and
affected versions, but never include real Terraform state, credentials, tokens,
or private keys.

Only the latest repository state is maintained. Security fixes may require
consumers to update their pinned commit SHA.

## Operational requirements

- Grant Contents read for normal restore and Contents write only for bootstrap,
  save, and reset.
- Prefer short-lived GitHub App installation tokens for cross-repository access.
- Do not use a classic PAT as the primary production credential.
- Keep `age-identities` in GitHub Actions secrets or an external secret manager.
- Use workflow concurrency with `cancel-in-progress: false`.
- Protect reset and recovery workflows with an approval boundary.
- Never upload state to logs, outputs, artifacts, or caches.

See the [threat model](docs/threat-model.md) for trust boundaries, controls, and
residual risks.

## Supply chain

Runtime packages and GitHub Actions are pinned. pnpm requires dependencies to
be published for at least 72 hours, rejects trust downgrades and exotic
transitive sources, and fails on unreviewed dependency build scripts. CI uses
the frozen lockfile, disables install scripts, and runs a full dependency
audit, dependency review, CodeQL, unit tests, and bundle synchronization.

`js-yaml@5.2.2` is the only age-gate exception because it is the patched
version for a known high-severity advisory; the exception is version-specific
and must not be broadened. Dependabot proposes reviewed package and action
updates.
