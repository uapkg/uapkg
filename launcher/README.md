# UAPKG launcher

The native executable selects and starts the TypeScript CLI. It owns CLI
installation, verified release metadata, the engine cache, and launcher updates.
See [the user guide](../docs/launcher.md) for installation and version selection.

`uapkg launcher --license` prints the executable's CycloneDX 1.6 software
bill of materials (SBOM). It works offline before a CLI is installed.

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

Cargo embeds the JSON produced by the pinned `cargo-cyclonedx` build dependency.
The generator uses the current target triple, the enabled launcher features,
and normal Cargo dependencies. An exact package URL in the
[shared license overrides](../tools/release/license-overrides.json) supplies
the license and its source links when the generated declaration is missing.

Normal builds embed two independent Minisign public keys from the repository:
[`docs/release-catalog-signing.pub`](../docs/release-catalog-signing.pub)
authenticates indexes and replacement mappings;
[`docs/release-signing.pub`](../docs/release-signing.pub) authenticates archive
checksums. Builds need no GitHub authentication or public-key environment
variables. Runtime and compile-time environment variables cannot replace these
keys. Unit tests use separate fixture keys.

Build a launcher with normal release selection and downloads from the repository
root:

```sh
vp run launcher:build
```

The executable is written to `launcher/target/release/` for the host platform.
Release CI checks that its configured signing keys match the tracked public keys.

## Distribution contract

Metadata comes exclusively from `https://releases.uapkg.dev/<product>/` for
`cli` or `launcher`: `index.json`, `replacements.json`, and their `.minisig`
signatures. Artifact URLs use
`/<product>/<version>/uapkg-<product>-<version>-<platform>.tar.gz`, redirecting to
GitHub Releases. Per-version `SHASUMS256.txt` and its signature authenticate the
archive. No GitHub REST release discovery, npm provider, or combined bundle exists.
Quarantined archive URLs return `410`; original GitHub assets and signed checksums
remain available.

Selectors are exact stable/numbered alpha or beta versions, `latest`, and
base-scoped alpha/beta aliases. Ordinary `latest` commands preserve the activated
stable version. Explicit install/default commands advance it. Preview aliases
follow signed mappings; exact previews can change through a same-base stable
replacement or status fallback. Status policy applies after those mappings: yanked and
quarantined versions fall back to the greatest lower healthy version for the
platform, staying stable or within a preview's base/stage. There is no client
retirement clock or metadata-age cutoff.

`~/.uapkg/engines/<version>/<platform>/` contains the extracted engine and an atomic
installation receipt. `~/.uapkg/catalog/<product>/` caches signed metadata and
selector resolutions. Cached metadata is reverified before use. Network
unavailability can fall back to verified state; signature failures fail closed.
Locks, bounded extraction, ordinary-file-only archives, and atomic activation
protect installation. Content-Length is optional; SHA-256 is authoritative.

Launcher JSON readers require the fields they understand and accept additional
fields without warnings. Unknown fields, including nested JSON values, survive
updates to existing records. Resolution, tracking, daily-check and signed-cache
envelope updates preserve extensions; new installations and update transactions
start fresh records. Signed metadata payloads retain their exact original bytes.
Known field types, supported values, schema versions, signatures, hashes and path
checks remain enforced. Additional fields do not enable features in older readers.
Published launcher versions through `0.3.4` retain their original strict readers.

The shared config owns `launcher.defaultCliVersion`, `launcher.autoLauncherUpdate`,
and `launcher.autoCLIUpdate`. The private `uapkg-slim-config` crate reads them using
the same default, global, intermediary, and local layers as `@uapkg/config`. Its
embedded JSON Schema and defaults are generated from that package, with no native
schema copy. Invalid overrides warn and retain earlier valid values. The CLI
persists configuration changes; the crate never writes. `version default`
continues to manage the global setting. Automatic updates default to on. Each
released invocation checks each product at most once in 24 hours, including pins
and diagnostics. Cached yank/quarantine policy applies on every invocation. The
installed CLI version for `latest` is recorded separately from configuration. Project
`uapkgVersion` and overrides use the same dedicated selector contract. Source
selection and cached npm engines are unsupported. Installation ownership remains
independent and restricts launcher replacement to standalone installations.
Quarantine purges managed CLI caches across platforms; yank retains them. Both
statuses require standalone launcher recovery before ordinary commands, regardless
of automatic-update settings. Package-owned launchers block those commands with
owner-specific update guidance. Identity probes remain available and development
bindings are exempt.

Run `vp run launcher:schema` to regenerate the embedded schema and
`vp run launcher:schema:check` to check it without writing. Repository build
wrappers regenerate before native compilation, and CI rejects stale generated
artifacts. Direct Cargo builds use the checked-in artifact without invoking Node.

The launcher preserves Unix process replacement and direct Windows terminal
inheritance. Startup notices use stderr; the narrow versioned
`UAPKG_LAUNCHER_NOTICES` payload asks the CLI to repeat them at normal completion.
Older engines may only show startup notices. No footer is guaranteed after forced
termination. Machine stdout and delegated exit codes remain unchanged.

`launcher-update` verifies the independent launcher artifact, checks the staged
executable, and preserves the existing journal, verified backup, rollback, and
Windows cleanup behavior. After automatic replacement, the new launcher runs the
original command with its arguments, working directory, and terminal streams.

The `development` Cargo feature prints `DEVELOPMENT BUILD [LAUNCHER]` on stderr
before command processing.
The banner uses white text on a dark red background (RGB 128, 0, 0), or plain text
when stderr is redirected or color is disabled. The development CLI follows with
its blue `DEVELOPMENT BUILD [CLI]` banner.

Development receipts bind the launcher to an absolute checkout,
Node executable, and CLI entrypoint. They use `~/.uapkg-development` and execute
local code without release selection. Explicit overrides are rejected; use an
official launcher to exercise release routing.
