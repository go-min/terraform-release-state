# Preview API review

Review target: the API at preview `v0.1.0-preview.5`, plus the current reset and
backup hardening changes.

## Review result

The API is suitable for continued preview validation. It is not frozen for
`v1` and has no authorization to change a production consumer.

## Contract checklist

- Operations are explicit: `restore`, `save`, `reset`.
- Missing state fails closed unless `bootstrap: true` is supplied.
- Save requires the restore marker whenever current remote state exists.
- Reset requires exact `confirmation: RESET` and audits the Release namespace.
- State contents, credentials, and keys are not outputs.
- Cross-repository storage is supported through the configured repository and
  token.
- Outputs are diagnostics and opaque consistency data only.
- Plain state is the default preview format; opt-in age ciphertext has a
  versioned current `.metadata.json` record and fails closed on mismatch.
- Encryption is explicit and accepts only native X25519 age recipients and
  secret identities.

## Error behavior

Errors are action failures with contextual messages. Retryable API failures are
retried; permission, validation, integrity, and consistency failures are not
converted into bootstrap or last-write-wins behavior. Delete 404s are safe
idempotent success. Reset refuses before mutation if unrelated Release assets
are present.

## Open items before v1

- Run live integration coverage for upload failure and recovery behavior.
- Review permissions and GitHub App token examples with the production
  consumer, without changing that consumer in this repository.
- Decide the final stable input/output compatibility policy.
