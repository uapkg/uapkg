# @uapkg/log

## 1.5.1

## 1.5.0

## 1.4.0

## 1.3.2

## 1.3.1

### Patch Changes

- [`3e8fc87`](https://github.com/MaximDevoir/uapkg/commit/3e8fc87e928eabd48315ac71f6030955b322a3b5) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Internal migration to Vite+

## 1.3.0

## 1.2.0

## 1.1.10

### Patch Changes

- [`253e64f`](https://github.com/MaximDevoir/uapkg/commit/253e64f0d0e4b18d97c5da3d2bb982de516dc923) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - chore: sync dependencies

## 1.1.9

### Patch Changes

- [`4a76025`](https://github.com/MaximDevoir/uapkg/commit/4a7602561ce4585e5b9045684e4a6dd9a155738e) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - fix: build before publish

## 1.1.8

### Patch Changes

- [`e2c21da`](https://github.com/MaximDevoir/uapkg/commit/e2c21dad6c2164cbf73f35038cb66b4ecbe3a949) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - chore: remove unused README files from uapkg packages

## 1.1.7

### Patch Changes

- [`c89d066`](https://github.com/MaximDevoir/uapkg/commit/c89d066831e1add8785fe77912222f892927d389) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - ci: OIDC CI Publish Test

## 1.1.6

### Patch Changes

- [`3b8964b`](https://github.com/MaximDevoir/uapkg/commit/3b8964b57adac9f7af285642769377d564cce00a) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Finish up moving to dedicated Git repo

- [`407c318`](https://github.com/MaximDevoir/uapkg/commit/407c318ca0d863f9b8b7a534d6d5948569f19d56) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - bump version

## 0.1.2

### Patch Changes

- [`9a201d9`](https://github.com/MaximDevoir/ATO/commit/9a201d991610054f0fcde5d3d4e352809af10d9d) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - fix: refactor to replace `uapkg` package with `@uapkg/cli` across dependencies and services

## 0.1.1

### Patch Changes

- [`7d9cd65`](https://github.com/MaximDevoir/ATO/commit/7d9cd65d818aecb6409d3ba9fa21d3dd1ce43a30) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - # New Package: `@uapkg/diagnostics`

  **Location:** `packages/uapkg-diagnostics/`

  Provides structured, throw-free error handling across the `uapkg` monorepo.

  ***

  ## Core Types & Utilities
  - `Diagnostic`
    Base type with: `level`, `code`, `message`, `hint`, `data`

  - `DiagnosticBag`
    Collector with:

    - `add()`
    - `mergeArray()`
    - `hasErrors()`
    - `toFailure()`

  - `Result<T>`
    Union type:

    - `ResultOk<T>`
    - `ResultFail`

  - Factory helpers:
    - `ok()`
    - `fail()`
    - `fromDiagnostics()`

  ***

  ## Diagnostic Families

  ### General
  - `PARSE_ERROR`
  - `IO_ERROR`
  - `UNKNOWN_ERROR`

  ### Manifest
  - `MANIFEST_INVALID`
  - `LOCKFILE_INVALID`
  - `FORBIDDEN_OVERRIDES`
  - `UNRESOLVED_REGISTRY`
  - `MANIFEST_READ_ERROR`
  - `MANIFEST_WRITE_ERROR`

  ### Registry
  - `SCHEMA_INVALID`
  - `GIT_ERROR`
  - `NETWORK_ERROR`
  - `REGISTRY_NOT_FOUND`
  - `CACHE_READ_ERROR`
  - `LOCK_ACQUISITION_FAILED`

  ### Resolver
  - `VERSION_CONFLICT`
  - `VERSION_NOT_FOUND`
  - `PACKAGE_NOT_FOUND`
  - `CIRCULAR_DEP`
  - `REGISTRY_NAME_COLLISION`

  ### Pack
  - `CYCLIC_SYMLINK`
  - `SYMLINK_OUTSIDE_ROOT`
  - `INVALID_PATH`
  - `PLUGIN_ROOT_NOT_FOUND`
  - `UNRESOLVED_LFS`
  - `LFS_SKIPPED`
  - `NO_FILES_SELECTED`
  - `OUTFILE_IS_DIRECTORY`

  ***

  # Updates

  ## `@uapkg/config`
  - `ConfigFileRepository.read()` → `Result<ConfigReadResult>`
  - `ConfigFileRepository.write()` → `Result<void>`

  - `ConfigWriter`

    - `getRaw()`
    - `listRaw()`
    - `prepareSet()`
    - `prepareDelete()`
      → all return `Result<T>`

  - `ConfigLayerBuilder`
    Returns empty values on read failure

  - `ConfigInstance`
    Handles `Result` internally, exposes clean API

  - `pathSchema.validateConfigPath()` → `Result<void>`

  ***

  ## `@uapkg/pack`
  - `PackService.pack()` → `Promise<Result<PackResult>>`
  - `FileCrawler.collect()` → `Result<CollectedFile[]>`
  - `PluginRootResolver.resolve()` → `Result<ResolvedRoots>`
  - `PackManifestReader.read()` → `Result<PackManifest>`

  ***

  ## CLI
  - `ConfigCommand`

    - Handles `Result` from config operations
    - Returns exit code `1` on failure
    - Prints diagnostics

  - `PackCommand`
    - Handles `Result` from `pack()`
    - Logs diagnostics on failure

  ***

  # Tests
  - `diagnostics.test.ts`
    Covers `Result`, `DiagnosticBag`, and helpers

  - `config-instance.test.ts`
    Updated for nullable `getWithOrigin`

  - `pack-service.test.ts`
    Unwraps `Result` before accessing values

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

- [`0bb07e6`](https://github.com/MaximDevoir/ATO/commit/0bb07e62abe70d716019a5089650f829c380a44b) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - feat: add @uapkg/config and @uapkg/log
