# Security policy

Do not report vulnerabilities publicly. Open a private security advisory or
contact the organization owner with reproduction details and no credentials or
state contents.

The action never logs state or credentials and does not expose state through
outputs. Consumers must provide the minimum token scope needed by the operation:
Contents read for restore and Contents write for save, backup, and retention.

The action does not provide locking. Consumer workflows must use a shared
concurrency group with `cancel-in-progress: false`.
