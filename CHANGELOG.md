# Changelog

Release history for Terraform Release State.

## [0.6.0](https://github.com/go-min/terraform-release-state/compare/v0.5.0...v0.6.0) (2026-07-29)


### Features

* restore configurable encrypted state protocol ([#39](https://github.com/go-min/terraform-release-state/issues/39)) ([4902400](https://github.com/go-min/terraform-release-state/commit/490240065b2ed7d16ce7912f962c3b00b648d82f))


### Bug Fixes

* clean failed crypto integration bootstrap ([#40](https://github.com/go-min/terraform-release-state/issues/40)) ([5b9378c](https://github.com/go-min/terraform-release-state/commit/5b9378c761bdd4b2da5f3449acf2dddec29af9be))

## [0.5.0](https://github.com/go-min/terraform-release-state/compare/v0.4.0...v0.5.0) (2026-07-29)


### Features

* establish zero-config state protocol ([#37](https://github.com/go-min/terraform-release-state/issues/37)) ([18890fa](https://github.com/go-min/terraform-release-state/commit/18890fa147b9eca75d8fd832063237d8344060c3))

## [0.4.0](https://github.com/go-min/terraform-release-state/compare/v0.3.1...v0.4.0) (2026-07-28)


### Features

* add signed state manifests ([#35](https://github.com/go-min/terraform-release-state/issues/35)) ([ebf2006](https://github.com/go-min/terraform-release-state/commit/ebf2006d4749660cad666f2f3fdeed6c38d96702))

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
