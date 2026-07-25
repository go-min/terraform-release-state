# Encryption proposal

Status: accepted and implemented for preview. It does not migrate existing
Release assets; encrypted state storage must use a new dedicated tag or an
explicitly approved migration procedure.

## Recommendation

Add an opt-in `age` mode backed by the `age-encryption` TypeScript package. It
implements the interoperable `age-encryption.org/v1` format, runs on Node 20+
(therefore Node 24), and avoids a runtime `age` binary or shell command.

The initial scope is binary age files encrypted to one or more native X25519
`age1...` recipients. Do not support passphrases, SSH recipients, plugins, or
post-quantum recipients in the first encrypted preview. They expand the key
handling and recovery contract without being necessary for CI state storage.

## Proposed API

```yaml
with:
  encryption: age # default: none; enum: none | age
  age-recipients: | # required for save with encryption: age
    age1recipientone...
    age1recipienttwo...
  age-identities:
    ${{ secrets.TF_STATE_AGE_IDENTITIES }}
    # required for restore with encryption: age
```

- `age-recipients` is newline-delimited public recipient material. Empty lines
  and comments are ignored; duplicates are rejected after normalization.
- `age-identities` is newline-delimited `AGE-SECRET-KEY-1...` material. It is
  read as a secret, masked before processing, never logged, never emitted, and
  never written to disk by the action.
- `encryption: none` remains the default for preview compatibility. If a
  current-state metadata record says `age`, `none` fails closed; if it says
  `none`, `age` fails closed. There is no auto-detection fallback.
- `reset` does not accept or require encryption inputs. It deletes only the
  configured state namespace after its existing audit.

There are no encryption outputs. Existing state checksum outputs retain their
current semantics and are not encryption-key identifiers.

## Proposed storage format

The current asset keeps its configured name (`terraform.tfstate` by default)
but contains age ciphertext when encryption is enabled. This preserves the
existing backup namespace and optimistic marker behavior: markers and GitHub
asset digests identify the ciphertext that is actually stored remotely.

The action adds one current-state metadata asset:

```text
terraform.tfstate.metadata.json
```

Its versioned, non-secret content is limited to:

```json
{
  "format_version": 1,
  "encryption": "age",
  "ciphertext_sha256": "<sha256>",
  "action_version": "<action ref>"
}
```

Do not store recipient lists, identities, passphrases, or plaintext checksums
in remote metadata. Existing backup metadata remains `.metadata.json`; its
checksum describes the stored backup ciphertext. Reset must recognize and
delete the exact current metadata filename as part of the state namespace.

## Lifecycle and failure behavior

1. Restore downloads and verifies the ciphertext, downloads current metadata,
   validates the version and selected encryption mode, then decrypts into the
   consumer's configured `state-path` using the secure atomic file writer.
2. Save reads the local plaintext state, encrypts it in memory, creates a
   ciphertext backup plus JSON metadata, and performs the existing marker,
   replacement, download verification, rollback, and retention steps over the
   ciphertext.
3. The current metadata is uploaded and verified as part of the same save
   transaction. A missing, malformed, or incompatible metadata record is an
   integrity failure, never a bootstrap signal.
4. If upload or verification fails after replacement, recovery restores the
   prior ciphertext and its matching metadata only when the remote resource has
   not changed concurrently. Otherwise the action stops with recovery
   instructions.

There is deliberately no plain-to-encrypted or encrypted-to-plain migration in
the first encryption preview. Use a separate Release tag/state copy and a
reviewed recovery procedure. An in-place migration changes the disaster
recovery boundary and needs its own approval.

## Key rotation and recovery

Rotate by saving with both old and new public recipients, validating restore
with the new identity, then saving again with only the new recipient. Preserve
the old identity until the retention window has expired and every encrypted
backup has been recovered or intentionally retired. A lost identity means the
corresponding state and backups are unrecoverable; GitHub access alone is not a
recovery mechanism.

Use a short-lived GitHub App token for Release access and a GitHub Actions
secret (or an external secret manager) for the age identity. A classic PAT is
not a recommended production authentication mechanism. Do not pass identities
through repository variables, outputs, artifacts, command lines, or files.

## Alternatives rejected

| Alternative                                 | Decision                                                                                                                              |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- |
| Invoke `age` CLI                            | Rejected: runner/binary availability and binary supply-chain management become action runtime dependencies.                           |
| Implement age directly with Node Web Crypto | Rejected: the format is security-sensitive; maintaining a bespoke implementation is disproportionate.                                 |
| Passphrase encryption                       | Rejected: it encourages static shared secrets, complicates non-interactive delivery, and has weak rotation/recovery ergonomics.       |
| Keep plaintext asset name with no metadata  | Rejected: the configured encryption mode could be applied to the wrong format; a versioned `.metadata.json` lets restore fail closed. |

## Required verification before implementation

- Native Node tests for malformed recipients/identities, wrong identity,
  ciphertext tampering, metadata mismatch, key rotation, and no state/key logs.
- Mock GitHub API tests for current metadata upload, rollback, retention, and
  reset namespace handling.
- Disposable integration coverage that writes only a unique test tag, verifies
  that the stored asset is not plaintext, restores it, and cleans all assets in
  `always()` cleanup.
- Interoperability vectors from the age specification or an independently
  generated age fixture; do not make the action depend on the CLI at runtime.
- Dependency review and lockfile update for the exact `age-encryption` release
  and its transitive cryptography packages.

## Sources

- [age format and CLI documentation](https://github.com/FiloSottile/age)
- [age-encryption TypeScript implementation](https://github.com/FiloSottile/typage)
- [Node 24 Web Crypto API](https://nodejs.org/download/release/v24.15.0/docs/api/webcrypto.html)
