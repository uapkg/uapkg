# UAPKG launcher

The native executable selects and starts the TypeScript CLI. It owns CLI
installation, verified release metadata, the engine cache, and launcher updates.
See [the user guide](../docs/launcher.md) for installation and version selection.

## Development

Rustup reads the exact toolchain pin from this directory. Repository wrappers use
the managed Node path for terminal tests:

```sh
vp run launcher:format
vp run launcher:lint
vp run launcher:test
```

When running Cargo directly, use `launcher/` as the working directory:

```sh
cargo test --locked --all-features
cargo clippy --locked --all-targets --all-features -- -D warnings
```

Official builds embed two independent Minisign public keys at compile time:
`UAPKG_CATALOG_PUBLIC_KEY` authenticates indexes and replacement mappings;
`UAPKG_RELEASE_PUBLIC_KEY` authenticates archive checksums. Runtime environment
variables cannot replace these keys. A build without keys can execute installed
exact engines but cannot resolve remote aliases or install artifacts.

## Distribution contract

Metadata comes exclusively from `https://releases.uapkg.dev/<product>/` for
`cli` or `launcher`: `index.json`, `replacements.json`, and their `.minisig`
signatures. Artifact URLs use
`/<product>/<version>/uapkg-<product>-<version>-<platform>.tar.gz`, redirecting to
GitHub Releases. Per-version `SHASUMS256.txt` and its signature authenticate the
archive. No GitHub REST release discovery, npm provider, or combined bundle exists.

Selectors are exact stable/numbered alpha or beta versions, `latest`, and
base-scoped alpha/beta aliases. Ordinary `latest` commands preserve the activated
stable version. Explicit install/default commands advance it. Preview aliases
follow signed mappings; exact previews only change through an explicit same-base
stable replacement. There is no client retirement clock or metadata-age cutoff.

`~/.uapkg/engines/<version>/<platform>/` contains the extracted engine and an atomic
installation receipt. `~/.uapkg/catalog/<product>/` caches signed metadata and
selector resolutions. Cached metadata is reverified before use. Network
unavailability can fall back to verified state; signature failures fail closed.
Locks, bounded extraction, ordinary-file-only archives, and atomic activation
protect installation. Content-Length is optional; SHA-256 is authoritative.

The shared config owns `launcher.defaultCliVersion`, `launcher.autoLauncherUpdate`,
and `launcher.autoCLIUpdate`. Rust reads them from the global config and the CLI
persists configuration changes. Automatic updates default to on. An eligible
command checks each product at most once in 24 hours. The installed CLI version
for `latest` is recorded separately from configuration. Project
`uapkgVersion` and overrides use the same dedicated selector contract. Source
selection and cached npm engines are unsupported. Installation ownership remains
independent and restricts launcher replacement to standalone installations.

The launcher preserves Unix process replacement and direct Windows terminal
inheritance. Startup notices use stderr; the narrow versioned
`UAPKG_LAUNCHER_NOTICES` payload asks the CLI to repeat them at normal completion.
Older engines may only show startup notices. No footer is guaranteed after forced
termination. Machine stdout and delegated exit codes remain unchanged.

`launcher-update` verifies the independent launcher artifact, checks the staged
executable, and preserves the existing journal, verified backup, rollback, and
Windows cleanup behavior. After automatic replacement, the new launcher runs the
original command with its arguments, working directory, and terminal streams.

The `development` Cargo feature permits receipts bound to an absolute checkout,
Node executable, and CLI entrypoint. They use `~/.uapkg-development` and execute
local code without release selection. Explicit overrides are rejected; use an
official launcher to exercise release routing.
