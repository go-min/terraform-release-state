# Architecture

## Recommendation

Keep the action as a TypeScript `.mts` Node 24 action compiled into a committed
`dist/index.js` bundle. Use `@actions/github` for the GitHub REST API and keep
GitHub API calls behind `src/github-api.mts`.

The lifecycle is split into restore/save/reset orchestration, pure marker and
validation logic, and a small runtime adapter. This keeps destructive behavior
reviewable and lets tests use mock Octokit clients without a live Release.

## Alternatives considered

| Approach                              | Advantages                                                                                    | Costs / decision                                                                                            |
| ------------------------------------- | --------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| TypeScript Node action with Octokit   | Portable on GitHub runners, typed API, one runtime dependency, easy bundling and native tests | Requires committed generated bundle; **selected**                                                           |
| Composite action using `gh` and shell | Small initial YAML, familiar CLI                                                              | External CLI/runtime assumptions, difficult binary/state handling, weaker error and retry control; rejected |
| Docker action                         | Reproducible OS and dependencies                                                              | Slow startup, larger supply-chain surface, less portable to runner constraints; rejected                    |
| Terraform backend/provider            | Native Terraform locking and lifecycle                                                        | Different product boundary, more infrastructure, cannot preserve Release asset workflow; out of scope       |

## API and data flow

```text
consumer workflow
  restore -> local state + opaque marker
  Terraform execution (consumer-owned)
  save    -> marker check -> backup -> replace -> verify -> retain
  reset   -> exact confirmation -> namespace audit -> delete assets -> re-audit -> release -> tag
```

The action never returns state contents. Reset audits all assets before the first
delete and refuses a Release containing assets outside the configured current
state/backup namespace.

## Reliability model

- Retry idempotent reads/deletes for `429` and transient `5xx` API responses
  with bounded exponential delay.
- Do not blindly retry create/upload POSTs. After an ambiguous POST failure,
  inspect the target Release/asset and accept it only when it is the intended
  resource with the expected content.
- Treat delete `404` as idempotent success.
- Verify downloaded assets against GitHub's digest when available.
- Verify an uploaded current asset by downloading it again.
- Preserve optimistic consistency checks even when the consumer also uses
  workflow concurrency.
- Treat Release asset replacement as non-atomic. If upload or verification
  fails after deletion, attempt to restore the prior current asset without
  overwriting a concurrently changed replacement.

## Versioning and review

The project remains preview-only. Inputs and outputs may change before `v1`.
Preview tags are immutable release milestones; stable `v1` requires explicit
API review and successful integration coverage. Consumers should pin a commit
SHA. No production migration is part of this change.
