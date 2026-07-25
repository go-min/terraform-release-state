# API, state format, and encryption decisions

Status: preview decision record. These decisions are intentionally revisable
before `v1`.

## Public API decision

Operations:

- `restore`: fetch current state or explicitly bootstrap missing storage;
- `save`: persist local state with optimistic consistency protection;
- `reset`: explicitly delete one dedicated state Release and its tag.

Core inputs are `github-token`, `state-repository`, `release-tag`, `state-asset`,
and `state-path` for restore/save. `bootstrap`, `expected-remote-state-marker`,
backup retention, and recovery metadata support lifecycle behavior. Reset uses
`confirmation: RESET`; the operation already supplies the semantic context, so
the input does not redundantly repeat the reset operation name.

Reset is fail-closed: missing or incorrect confirmation performs no delete;
unexpected Release assets abort before the first delete. Outputs contain only
identifiers, markers, checksums, counts, and status—not state, credentials, or
keys.

## State format decision

Keep the preview format unchanged:

```text
terraform.tfstate
terraform.tfstate.backup-<timestamp>-<run-id>-<uuid>
terraform.tfstate.backup-<timestamp>-<run-id>-<uuid>.metadata.json
```

The backup metadata remains JSON and includes timestamp, source commit, workflow
run ID, action version, current asset name, and SHA-256. Backup names now include
milliseconds and a UUID to avoid collisions when one workflow saves repeatedly.
This is a naming hardening change, not a state-content migration.

## Encryption decision

The preview supports opt-in `encryption: age` with newline-delimited native
X25519 recipients and identities. The action uses the interoperable age format
in its Node runtime; it does not require or invoke an `age` CLI. The current
asset stores ciphertext and has a versioned `<state-asset>.metadata.json`
record; backups remain ciphertext with `.metadata.json` recovery metadata.

Passphrases, SSH recipients, plugins, post-quantum recipients, and automatic
plain/encrypted migration are deliberately unsupported. Existing plain storage
continues to work with `encryption: none`; encrypted storage with missing or
incompatible metadata fails closed.

Identities are secret inputs, masked before use, never written by the action,
never logged, and never returned through outputs. Rotation uses overlapping
recipient sets and must retain old identities for the backup retention window.

## Compatibility decision

Because this is pre-`v1`, API cleanup and breaking changes are allowed when
documented in a preview release. Stable `v1` is explicitly out of scope here.
