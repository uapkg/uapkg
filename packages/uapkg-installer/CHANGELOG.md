# @uapkg/installer

## 1.5.0

### Patch Changes

- Updated dependencies [[`9315a6f`](https://github.com/uapkg/uapkg/commit/9315a6fd6f7d56723563dc45c22f278a464aa8f5)]:
  - @uapkg/config@1.5.0
  - @uapkg/package-manifest-schema@1.5.0
  - @uapkg/common@1.5.0
  - @uapkg/common-schema@1.5.0
  - @uapkg/diagnostics@1.5.0
  - @uapkg/package-claims@1.5.0
  - @uapkg/package-manifest@1.5.0
  - @uapkg/registry-core@1.5.0
  - @uapkg/registry-schema@1.5.0

## 1.4.0

### Patch Changes

- Updated dependencies [ab49fc7]
  - @uapkg/registry-schema@1.4.0
  - @uapkg/common@1.4.0
  - @uapkg/common-schema@1.4.0
  - @uapkg/config@1.4.0
  - @uapkg/diagnostics@1.4.0
  - @uapkg/package-claims@1.4.0
  - @uapkg/package-manifest@1.4.0
  - @uapkg/package-manifest-schema@1.4.0
  - @uapkg/registry-core@1.4.0

## 1.3.2

### Patch Changes

- Updated dependencies [[`1ac5069`](https://github.com/MaximDevoir/uapkg/commit/1ac5069ecebae08cee60bcc52c40e5c4f948ed07)]:
  - @uapkg/common@1.3.2
  - @uapkg/common-schema@1.3.2
  - @uapkg/config@1.3.2
  - @uapkg/diagnostics@1.3.2
  - @uapkg/package-claims@1.3.2
  - @uapkg/package-manifest@1.3.2
  - @uapkg/package-manifest-schema@1.3.2
  - @uapkg/registry-core@1.3.2
  - @uapkg/registry-schema@1.3.2

## 1.3.1

### Patch Changes

- [`aa1e603`](https://github.com/MaximDevoir/uapkg/commit/aa1e6032928cfeab7afcbce54cabf9858c10677d) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Download registry artifacts through bounded, scheme-safe redirects and retain byte-stream compatibility with legacy GitHub release-asset API URLs.

- [`2a3f4de`](https://github.com/MaximDevoir/uapkg/commit/2a3f4de35497b34d02414413bc64dafb587044a2) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Publish normalized package-claims schemas and the versioned registry metadata contract, with a shared context-aware package-registry manifest validator for public and private registries.

  Share compatible Zod instances through peer dependencies, permit private registry records and lock entries without Git trees, and fail closed on missing or unsupported registry metadata and public records missing required Git provenance.

  Represent common-schema brands with JSON Schema-compatible type-only branding, expose package-name constraints on claims record keys, and reject non-canonical prefixed package versions.

- [`3e8fc87`](https://github.com/MaximDevoir/uapkg/commit/3e8fc87e928eabd48315ac71f6030955b322a3b5) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Internal migration to Vite+

- Updated dependencies [[`1b0e624`](https://github.com/MaximDevoir/uapkg/commit/1b0e624c8f78a1c496cef389838948e94f742c7f), [`2a3f4de`](https://github.com/MaximDevoir/uapkg/commit/2a3f4de35497b34d02414413bc64dafb587044a2), [`3e8fc87`](https://github.com/MaximDevoir/uapkg/commit/3e8fc87e928eabd48315ac71f6030955b322a3b5)]:
  - @uapkg/diagnostics@1.3.1
  - @uapkg/common-schema@1.3.1
  - @uapkg/config@1.3.1
  - @uapkg/package-claims@1.3.1
  - @uapkg/package-manifest-schema@1.3.1
  - @uapkg/registry-schema@1.3.1
  - @uapkg/registry-core@1.3.1
  - @uapkg/package-manifest@1.3.1
  - @uapkg/common@1.3.1

## 1.3.0

### Patch Changes

- Updated dependencies []:
  - @uapkg/common@1.3.0
  - @uapkg/common-schema@1.3.0
  - @uapkg/config@1.3.0
  - @uapkg/diagnostics@1.3.0
  - @uapkg/package-claims@1.3.0
  - @uapkg/package-manifest@1.3.0
  - @uapkg/package-manifest-schema@1.3.0
  - @uapkg/registry-core@1.3.0
  - @uapkg/registry-schema@1.3.0

## 1.2.0

### Minor Changes

- [`3f4fadb`](https://github.com/MaximDevoir/uapkg/commit/3f4fadbb963d78df7715a5b48350e25dff81575c) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Move publishing and installation to the artifact-first v1 model.

  `uapkg publish` now observes the exact release artifact (fresh download or `--asset-path`), reads the packaged `uapkg.json` claims from it, and submits the observed integrity and normalized claims to the dedicated `POST /v1/registry-requests/publish` route with a persisted idempotency key, polling the new `queued → checking → accepted → ready` status vocabulary (`--manifest-path` and client-side kind selection are removed). New `uapkg yank`, `unyank`, `unpublish`, `deprecate`, and `undeprecate` commands submit the route-derived lifecycle operations.

  The new `@uapkg/package-claims` package provides the shared packaged-manifest reader, canonical-JSON claims normalization, and comparison used by both publish preflight and the installer. Installation is now verification-gated: every package must pass exact size, SHA-256, and packaged-claims comparison before activation, dependency edges are only trusted from verified parents, and installs report installed/failed/skipped outcomes instead of failing open.

  Schemas adopt the v1 contracts: scoped package names (`@scope/name`) with a shared registry path layout, exact `sha256:`-prefixed asset hashes, a normalized `private` flag on registry version records with tolerant parsing of unknown members, inherited registries expressed by omission, and a fail-closed lockfile version.

### Patch Changes

- Updated dependencies [[`3f4fadb`](https://github.com/MaximDevoir/uapkg/commit/3f4fadbb963d78df7715a5b48350e25dff81575c), [`ed4ab0a`](https://github.com/MaximDevoir/uapkg/commit/ed4ab0a2ade631e882dfa551db1daa7b6031d7b6), [`2d9b24a`](https://github.com/MaximDevoir/uapkg/commit/2d9b24aa5b64f8e9fce4621f26dfbed8f700a98c), [`848a0c5`](https://github.com/MaximDevoir/uapkg/commit/848a0c5d9e25aeb69b829a2fd0ca1f78016273bb), [`2394f0a`](https://github.com/MaximDevoir/uapkg/commit/2394f0a1f602a654f735d727d06f7e90f236f12f), [`2394f0a`](https://github.com/MaximDevoir/uapkg/commit/2394f0a1f602a654f735d727d06f7e90f236f12f), [`42cce65`](https://github.com/MaximDevoir/uapkg/commit/42cce65960a0e45ef800af0a4f8711b8ee92b065)]:
  - @uapkg/common-schema@1.2.0
  - @uapkg/package-claims@1.2.0
  - @uapkg/package-manifest@1.2.0
  - @uapkg/package-manifest-schema@1.2.0
  - @uapkg/registry-core@1.2.0
  - @uapkg/registry-schema@1.2.0
  - @uapkg/diagnostics@1.2.0
  - @uapkg/config@1.2.0
  - @uapkg/common@1.2.0

## 1.1.10

### Patch Changes

- [`253e64f`](https://github.com/MaximDevoir/uapkg/commit/253e64f0d0e4b18d97c5da3d2bb982de516dc923) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - chore: sync dependencies

- Updated dependencies [[`253e64f`](https://github.com/MaximDevoir/uapkg/commit/253e64f0d0e4b18d97c5da3d2bb982de516dc923)]:
  - @uapkg/common@1.1.10
  - @uapkg/common-schema@1.1.10
  - @uapkg/config@1.1.10
  - @uapkg/diagnostics@1.1.10
  - @uapkg/package-manifest@1.1.10
  - @uapkg/package-manifest-schema@1.1.10
  - @uapkg/registry-core@1.1.10

## 1.1.9

### Patch Changes

- [`4a76025`](https://github.com/MaximDevoir/uapkg/commit/4a7602561ce4585e5b9045684e4a6dd9a155738e) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - fix: build before publish

- Updated dependencies [[`4a76025`](https://github.com/MaximDevoir/uapkg/commit/4a7602561ce4585e5b9045684e4a6dd9a155738e)]:
  - @uapkg/package-manifest-schema@1.1.9
  - @uapkg/package-manifest@1.1.9
  - @uapkg/common-schema@1.1.9
  - @uapkg/registry-core@1.1.9
  - @uapkg/diagnostics@1.1.9
  - @uapkg/common@1.1.9
  - @uapkg/config@1.1.9

## 1.1.8

### Patch Changes

- [`e2c21da`](https://github.com/MaximDevoir/uapkg/commit/e2c21dad6c2164cbf73f35038cb66b4ecbe3a949) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - chore: remove unused README files from uapkg packages

- Updated dependencies [[`e2c21da`](https://github.com/MaximDevoir/uapkg/commit/e2c21dad6c2164cbf73f35038cb66b4ecbe3a949)]:
  - @uapkg/config@1.1.8
  - @uapkg/common@1.1.8
  - @uapkg/common-schema@1.1.8
  - @uapkg/diagnostics@1.1.8
  - @uapkg/package-manifest@1.1.8
  - @uapkg/package-manifest-schema@1.1.8
  - @uapkg/registry-core@1.1.8

## 1.1.7

### Patch Changes

- [`c89d066`](https://github.com/MaximDevoir/uapkg/commit/c89d066831e1add8785fe77912222f892927d389) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - ci: OIDC CI Publish Test

- Updated dependencies [[`c89d066`](https://github.com/MaximDevoir/uapkg/commit/c89d066831e1add8785fe77912222f892927d389)]:
  - @uapkg/common@1.1.7
  - @uapkg/common-schema@1.1.7
  - @uapkg/config@1.1.7
  - @uapkg/diagnostics@1.1.7
  - @uapkg/package-manifest@1.1.7
  - @uapkg/package-manifest-schema@1.1.7
  - @uapkg/registry-core@1.1.7

## 1.1.6

### Patch Changes

- [`3b8964b`](https://github.com/MaximDevoir/uapkg/commit/3b8964b57adac9f7af285642769377d564cce00a) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Finish up moving to dedicated Git repo

- [`407c318`](https://github.com/MaximDevoir/uapkg/commit/407c318ca0d863f9b8b7a534d6d5948569f19d56) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - bump version

- Updated dependencies [[`3b8964b`](https://github.com/MaximDevoir/uapkg/commit/3b8964b57adac9f7af285642769377d564cce00a), [`407c318`](https://github.com/MaximDevoir/uapkg/commit/407c318ca0d863f9b8b7a534d6d5948569f19d56)]:
  - @uapkg/package-manifest-schema@1.1.6
  - @uapkg/package-manifest@1.1.6
  - @uapkg/common-schema@1.1.6
  - @uapkg/registry-core@1.1.6
  - @uapkg/diagnostics@1.1.6
  - @uapkg/common@1.1.6
  - @uapkg/config@1.1.6

## 0.1.2

### Patch Changes

- [`9a201d9`](https://github.com/MaximDevoir/ATO/commit/9a201d991610054f0fcde5d3d4e352809af10d9d) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - fix: refactor to replace `uapkg` package with `@uapkg/cli` across dependencies and services

- Updated dependencies [[`9a201d9`](https://github.com/MaximDevoir/ATO/commit/9a201d991610054f0fcde5d3d4e352809af10d9d)]:
  - @uapkg/common@0.1.2
  - @uapkg/common-schema@0.1.2
  - @uapkg/config@0.1.2
  - @uapkg/diagnostics@0.1.2
  - @uapkg/package-manifest@0.1.2
  - @uapkg/package-manifest-schema@0.1.2
  - @uapkg/registry-core@0.1.2

## 0.1.1

### Patch Changes

- [`7eb25bc`](https://github.com/MaximDevoir/ATO/commit/7eb25bcf841b17218aa2781befd48de737d82ea9) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - ## What Changed

  ### 1) `uapkg pack` improvements
  - Added pack-time exclusion of generated artifacts:
    - excludes `*.integrity`
    - excludes paired non-`.integrity` artifact
    - excludes current output archive path (and its `.integrity`) when inside plugin root
  - Added hard diagnostic failure when no `*.uplugin` descriptor exists.
  - Routed `uapkg pack` command failures through diagnostics reporter/formatter instead of raw log strings.

  ### 2) Diagnostics emit policy + dedupe
  - Extended base diagnostic model with emit metadata:
    - `emitPolicy: 'always' | 'once'`
    - `emitFingerprint`
  - Added reporter-side dedupe component and integrated it into `DiagnosticReporter`.
  - Dedupe state is process-wide (static) so "once" holds across reporter instances in one CLI lifetime.
  - Applied `emitPolicy: 'once'` to:
    - `REGISTRY_UNREACHABLE` (fingerprinted by registry name + URL)
    - `CONFIG_UNRESOLVED_DEFAULT_REGISTRY` (fingerprinted by registry name)

  ### 3) Registry singleton behavior
  - `RegistryCore` now uses a process-wide static registry pool so the same logical registry instance is reused across
    core instances.

  ### 4) Registry UX and command support
  - Improved `REGISTRY_NOT_FOUND` hint with actionable multiline setup guidance.
  - Added new CLI command: `uapkg registry`
    - `add`, `remove`, `list`, `use`
    - supports `--local` / `--global`
    - supports `--branch` / `--tag` / `--rev`
    - wraps `@uapkg/config` operations (no duplicate config logic)
  - `registry add` now writes `ref` atomically to avoid partial-object validation failures.

  ### 5) `config set` usability + tolerant config loading
  - `config set` now accepts scalar values (not JSON-only).
  - Added path-aware scalar parser for booleans/numbers/enums.
  - Added leaf-path enforcement for CLI `config set` (object-level writes rejected in CLI).
  - Added missing valid config paths and leaf-path helper.
  - Added full diagnostics-based tolerant config read/merge/resolve flow:
    - malformed JSON and type mismatches become diagnostics
    - unknown keys become diagnostics
    - no raw schema stack traces for recoverable issues
  - Split semantic validation out of base schema (`CONFIG_UNRESOLVED_DEFAULT_REGISTRY` etc).
  - Added deep-partial write schema support for `registries.*` so leaf updates like:
    - `registries.company.ref.type`
    - `registries.company.ref.value`
      work even when creating paths incrementally.

  ### 6) Diagnostics family/formatter additions for config
  - Added config diagnostic family and formatter/ink rendering support:
    - `CONFIG_INVALID_JSON`
    - `CONFIG_TYPE_MISMATCH`
    - `CONFIG_UNKNOWN_KEY`
    - `CONFIG_UNRESOLVED_DEFAULT_REGISTRY`
    - `CONFIG_INVALID_VALUE`
  - Wired into default formatter maps and ink component maps.

  ### 7) Runtime Ink stability fix
  - Fixed runtime `React is not defined` crashes in diagnostics ink views/components by adding runtime React imports in
    TSX files using JSX.

- [`3b9d01a`](https://github.com/MaximDevoir/ATO/commit/3b9d01afb678d003809e92f6457c5c704b4a4f0e) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - release patch bump

- Updated dependencies [[`7d9cd65`](https://github.com/MaximDevoir/ATO/commit/7d9cd65d818aecb6409d3ba9fa21d3dd1ce43a30), [`7eb25bc`](https://github.com/MaximDevoir/ATO/commit/7eb25bcf841b17218aa2781befd48de737d82ea9), [`3b9d01a`](https://github.com/MaximDevoir/ATO/commit/3b9d01afb678d003809e92f6457c5c704b4a4f0e), [`0bb07e6`](https://github.com/MaximDevoir/ATO/commit/0bb07e62abe70d716019a5089650f829c380a44b)]:
  - @uapkg/package-manifest-schema@0.1.1
  - @uapkg/package-manifest@0.1.1
  - @uapkg/common-schema@0.1.1
  - @uapkg/registry-core@0.1.1
  - @uapkg/diagnostics@0.1.1
  - @uapkg/common@0.1.1
  - @uapkg/config@0.1.1
