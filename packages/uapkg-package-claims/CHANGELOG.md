# @uapkg/package-claims

## 1.5.1

### Patch Changes

- Updated dependencies []:
  - @uapkg/common-schema@1.5.1
  - @uapkg/diagnostics@1.5.1
  - @uapkg/package-manifest-schema@1.5.1
  - @uapkg/registry-schema@1.5.1

## 1.5.0

### Patch Changes

- Updated dependencies [[`9315a6f`](https://github.com/uapkg/uapkg/commit/9315a6fd6f7d56723563dc45c22f278a464aa8f5)]:
  - @uapkg/package-manifest-schema@1.5.0
  - @uapkg/common-schema@1.5.0
  - @uapkg/diagnostics@1.5.0
  - @uapkg/registry-schema@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [ab49fc7]
  - @uapkg/registry-schema@1.4.0
  - @uapkg/common-schema@1.4.0
  - @uapkg/diagnostics@1.4.0
  - @uapkg/package-manifest-schema@1.4.0

## 1.3.2

### Patch Changes

- Updated dependencies []:
  - @uapkg/common-schema@1.3.2
  - @uapkg/diagnostics@1.3.2
  - @uapkg/package-manifest-schema@1.3.2
  - @uapkg/registry-schema@1.3.2

## 1.3.1

### Patch Changes

- [`2a3f4de`](https://github.com/MaximDevoir/uapkg/commit/2a3f4de35497b34d02414413bc64dafb587044a2) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Publish normalized package-claims schemas and the versioned registry metadata contract, with a shared context-aware package-registry manifest validator for public and private registries.

  Share compatible Zod instances through peer dependencies, permit private registry records and lock entries without Git trees, and fail closed on missing or unsupported registry metadata and public records missing required Git provenance.

  Represent common-schema brands with JSON Schema-compatible type-only branding, expose package-name constraints on claims record keys, and reject non-canonical prefixed package versions.

- [`3e8fc87`](https://github.com/MaximDevoir/uapkg/commit/3e8fc87e928eabd48315ac71f6030955b322a3b5) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Internal migration to Vite+

- Updated dependencies [[`1b0e624`](https://github.com/MaximDevoir/uapkg/commit/1b0e624c8f78a1c496cef389838948e94f742c7f), [`2a3f4de`](https://github.com/MaximDevoir/uapkg/commit/2a3f4de35497b34d02414413bc64dafb587044a2), [`3e8fc87`](https://github.com/MaximDevoir/uapkg/commit/3e8fc87e928eabd48315ac71f6030955b322a3b5)]:
  - @uapkg/diagnostics@1.3.1
  - @uapkg/common-schema@1.3.1
  - @uapkg/package-manifest-schema@1.3.1
  - @uapkg/registry-schema@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies []:
  - @uapkg/common-schema@1.3.0
  - @uapkg/diagnostics@1.3.0
  - @uapkg/package-manifest-schema@1.3.0
  - @uapkg/registry-schema@1.3.0

## 1.2.0

### Minor Changes

- [`3f4fadb`](https://github.com/MaximDevoir/uapkg/commit/3f4fadbb963d78df7715a5b48350e25dff81575c) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Move publishing and installation to the artifact-first v1 model.

  `uapkg publish` now observes the exact release artifact (fresh download or `--asset-path`), reads the packaged `uapkg.json` claims from it, and submits the observed integrity and normalized claims to the dedicated `POST /v1/registry-requests/publish` route with a persisted idempotency key, polling the new `queued → checking → accepted → ready` status vocabulary (`--manifest-path` and client-side kind selection are removed). New `uapkg yank`, `unyank`, `unpublish`, `deprecate`, and `undeprecate` commands submit the route-derived lifecycle operations.

  The new `@uapkg/package-claims` package provides the shared packaged-manifest reader, canonical-JSON claims normalization, and comparison used by both publish preflight and the installer. Installation is now verification-gated: every package must pass exact size, SHA-256, and packaged-claims comparison before activation, dependency edges are only trusted from verified parents, and installs report installed/failed/skipped outcomes instead of failing open.

  Schemas adopt the v1 contracts: scoped package names (`@scope/name`) with a shared registry path layout, exact `sha256:`-prefixed asset hashes, a normalized `private` flag on registry version records with tolerant parsing of unknown members, inherited registries expressed by omission, and a fail-closed lockfile version.

### Patch Changes

- Updated dependencies [[`3f4fadb`](https://github.com/MaximDevoir/uapkg/commit/3f4fadbb963d78df7715a5b48350e25dff81575c), [`ed4ab0a`](https://github.com/MaximDevoir/uapkg/commit/ed4ab0a2ade631e882dfa551db1daa7b6031d7b6), [`2d9b24a`](https://github.com/MaximDevoir/uapkg/commit/2d9b24aa5b64f8e9fce4621f26dfbed8f700a98c), [`848a0c5`](https://github.com/MaximDevoir/uapkg/commit/848a0c5d9e25aeb69b829a2fd0ca1f78016273bb), [`2394f0a`](https://github.com/MaximDevoir/uapkg/commit/2394f0a1f602a654f735d727d06f7e90f236f12f), [`42cce65`](https://github.com/MaximDevoir/uapkg/commit/42cce65960a0e45ef800af0a4f8711b8ee92b065)]:
  - @uapkg/common-schema@1.2.0
  - @uapkg/package-manifest-schema@1.2.0
  - @uapkg/registry-schema@1.2.0
  - @uapkg/diagnostics@1.2.0
