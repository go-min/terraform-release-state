# Architecture

Terraform Release State v0.6 is a Node.js 24 JavaScript action. TypeScript
`.mts` sources compile into the committed `dist/index.js` bundle.

```text
restore -> verify Release bundle -> local state + bound receipt
save    -> receipt CAS -> verified safety backup -> replace -> verify -> retain
import  -> verified remote state -> structural Terraform scan -> guarded PR
reset   -> namespace audit -> delete all, or verify/CAS-promote exact backup
```

## Configuration and storage

The default namespace is the workflow repository, tag `terraform-state`, asset
and local path `terraform.tfstate`, retention 20, encryption `none`, and
`allow-unsigned` signatures. Namespace, path, retention, crypto, and import
paths are explicit optional inputs. GitHub context derives source commit/run
provenance; import PRs always target the workflow repository.

Every manifest-v1 bundle has a state object and canonical manifest. Age current
objects also have compatibility metadata; all backup manifests have metadata.
Signed bundles also have a detached `*.manifest.sig.json`; upload order is
state, metadata, signature, manifest. The manifest is the completion signal and
records object identity, stored/plaintext digest and size, Terraform identity,
parent marker/digest, encryption key fingerprint, and provenance. Canonical
serializers strictly parse and reserialize manifest and signature bytes.

## Integrity and concurrency

Restore records the exact observed remote marker in a mode-0600 receipt under
`RUNNER_TEMP`. Save refuses a missing, changed, or newly appeared current
marker. Before mutation it loads every managed bundle, verifies manifests, and
requires decryption of encrypted current state. A signed current also requires
a private signing key: neither a safety backup nor replacement may silently
weaken protection.

New current and backup bundles are downloaded and cryptographically verified
after upload. Current replacement is compensated with previously verified full
bytes after partial failure. Manifest-last ordering makes incomplete upload
non-authoritative. Once replacement verification succeeds, the new marker and
`state-write-committed=true` are emitted before local receipt and retention.
Maintenance failures fail the action but preserve a machine-readable recovery
point.

Exact-backup reset applies the same preflight to current and target, creates a
verified safety backup, rechecks both markers, promotes with a new current
manifest last, and fully rolls back partial replacement. It does not retain
backups.

## Compatibility and import safety

v0.6 dual-reads legacy plaintext, v0.4 age/signed manifest bundles, and v0.5
plaintext manifests in place. Age needs identities; signed manifests need a
configured verification key, and `signature-policy=require` rejects unsigned
objects. There is no implicit namespace relocation, downgrade, or companion
deletion.

Import uses a tokenizer/parser rather than regex-only HCL guesses. It rejects
symlink/realpath workspace escapes, scans relevant `.tf` files below
`terraform-root`, suppresses declared targets, and does not read generated
output in PR mode. Its action-owned branch refresh inspects the full merge-base
diff, preserves latest base as an ancestor using a two-parent commit, and uses
an expected-SHA non-force ref update.
