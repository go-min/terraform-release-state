# Security policy

Do not report vulnerabilities publicly. Open a private security advisory or
contact the organization owner with reproduction details and no credentials or
state contents.

The action never logs state or credentials and does not expose state through
outputs. Consumers must provide the minimum token scope needed by the operation:
Contents read for restore and Contents write for save, backup, retention, and
reset. Reset also deletes the configured Release tag.

The action does not provide locking. Consumer workflows must use a shared
concurrency group with `cancel-in-progress: false`.

The repository pins direct package versions and GitHub Actions to immutable
commit SHAs. Pull requests receive dependency review, and the repository runs
CodeQL analysis on push, pull request, and a weekly schedule. Dependabot keeps
the pinned versions and action SHAs current through reviewed pull requests.
