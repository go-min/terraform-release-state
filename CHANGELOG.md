# Changelog

Release history for Terraform Release State.

## [0.3.1](https://github.com/go-min/terraform-release-state/compare/v0.3.0...v0.3.1) (2026-07-28)


### Bug Fixes

* harden state persistence lifecycle ([#33](https://github.com/go-min/terraform-release-state/issues/33)) ([fbbe5e3](https://github.com/go-min/terraform-release-state/commit/fbbe5e3d33a8c399eee23e9e3c50f979cb9d666d))

## [0.3.0](https://github.com/go-min/terraform-release-state/compare/v0.2.1...v0.3.0) (2026-07-28)


### Features

* harden import proposal automation ([#27](https://github.com/go-min/terraform-release-state/issues/27)) ([f75eafd](https://github.com/go-min/terraform-release-state/commit/f75eafd7cfb4f4a0a43c08f9b63159a118f0d4e9))


### Bug Fixes

* exclude generated changelog from lint ([#32](https://github.com/go-min/terraform-release-state/issues/32)) ([ec541ad](https://github.com/go-min/terraform-release-state/commit/ec541ad9a451dcf2b12fa6218fc5f846cc8df778))
* restore release-please lifecycle ([#30](https://github.com/go-min/terraform-release-state/issues/30)) ([3d981c6](https://github.com/go-min/terraform-release-state/commit/3d981c6032c80368ce40858d0333ec647db28f94))

## [0.2.1] — 2026-07-26

First public release of a reusable GitHub Action for managing Terraform state
through GitHub Release assets.

It provides a controlled state lifecycle for consumer workflows:

- restore and save with explicit bootstrap and optimistic consistency checks;
- SHA-256 integrity validation, verified uploads, backups, and retention;
- fail-closed recovery and native reset of the managed state Release;
- optional age encryption for state and backup assets;
- deterministic Terraform import proposals without running Terraform or
  modifying infrastructure.

The action does not provide native Terraform locking or replace Terraform
execution. Consumer workflows remain responsible for concurrency, credentials,
approvals, and protected environments.

[0.2.1]: https://github.com/go-min/terraform-release-state/releases/tag/v0.2.1
