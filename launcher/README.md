# UAPKG launcher

The native `uapkg` executable selects and starts the existing TypeScript CLI.
It owns CLI versions, downloads, the cache, and launcher updates. Package and
account operations stay in TypeScript.

## Development

Install Rust through Rustup. `rust-toolchain.toml` selects Rust 1.100.0 with
Rustfmt and Clippy. Run Cargo in this directory so Rustup reads that file:

```sh
cargo fmt --check
cargo clippy --locked --all-targets --all-features -- -D warnings
cargo test --locked --all-features
```

Terminal integration tests need Node.js. The repository's `vp run launcher:test`
wrapper supplies the Vite-managed Node path through `UAPKG_TEST_NODE`.
`Cargo.lock` pins resolved dependencies. Update the Rust toolchain and dependency
versions deliberately; release builds use the lockfile.

Official builds embed the base64 Minisign public key through
`UAPKG_RELEASE_PUBLIC_KEY` at compile time. A build without this key can run
bundled and cached engines but cannot download GitHub releases. Runtime
environment variables cannot replace the trust anchor.

## Selection

- `launcher`, `version`, and `self-update` are launcher commands.
- `login`, `logout`, and `whoami` use the configured global CLI.
- All other commands, including future commands, use the nearest ancestor
  project manifest's exact `uapkgVersion`. Plugin manifests are skipped while
  looking for a project. An unpinned project uses the global default.
- `--cli-version <exact-version>` (or `--cli-version=<exact-version>`) anywhere
  after `uapkg` overrides selection, including global commands.
- `--offline` anywhere after `uapkg` prohibits downloads. `UAPKG_OFFLINE=1` also
  enables offline mode. A missing version fails without substituting another.
- A standalone `--` ends launcher option parsing. It and all following arguments
  pass unchanged to the CLI; other arguments retain their order and values.
- `--version` describes the selected CLI. `launcher --version` describes the
  launcher. Top-level help includes a pointer to launcher commands and delegates
  CLI command help to the selected engine.

```sh
uapkg version install 1.4.0
uapkg version default latest
uapkg version current
uapkg version list
uapkg --cli-version 1.4.0 install
uapkg install --cli-version 1.4.0
uapkg --version --cli-version 1.4.0
uapkg install --offline
uapkg config get launcher.cliSource
uapkg config set launcher.cliSource npm --global
uapkg self-update
```

`latest` is resolved only by explicit version install/default commands. Ordinary
commands never check for updates. Launcher self-update selects signed launcher
versions from the repository's `@uapkg/cli@VERSION` releases and never uses an
unfiltered GitHub latest-release endpoint.

## Profiles and sources

Launcher settings use the existing global `~/.uapkg/config.json` under
`launcher.cliSource` and `launcher.defaultCliVersion`. Development bindings use
`~/.uapkg-development/config.json`. The TypeScript CLI owns all configuration
validation and writes. Rust only reads these two global values; local config
does not affect launcher source/default selection. Tests isolate the normal
profile with temporary `HOME` and `USERPROFILE` values.

The global source selects `github-releases` (the default) or `npm`. Source changes
preserve the exact default CLI version. `version default <version|latest>` installs
the selected release, then delegates `config set launcher.defaultCliVersion
<exact-version> --global` to that CLI. Development bindings delegate the write to
their local CLI to preserve the development profile. Other `config` commands
also require an available CLI; before one is installed, a source can be selected
by editing the global JSON file directly.
Cache identity includes source, version, and platform; sources never silently
fall back to each other.

GitHub engines include their own runtime. npm engines use Node.js 26+ from PATH
and the package's declared Node engine range. Installing an npm engine additionally
requires npm 11.12.1+ and its declared engine range. Cached npm engines require
only Node.js. The npm installer verifies package SRI, stages the published
`dist/runtime-lock.json` as `package-lock.json`, and runs frozen `npm ci` with
lifecycle scripts and bin links disabled.

Full bundles contain an installation receipt beside the executable and a `cli/`
engine. Their bundled default works without any download. A launcher-only
installation needs `version default <exact-version|latest>` once.

Installation ownership is separate from `cliSource`. A receipt records ownership;
`UAPKG_INSTALL_METHOD` can supply a build-time default. Standalone installations
can self-update. Package-manager and development installations receive instructions
for their owner instead. Self-update never edits a CLI default or project pin.

## Downloads and recovery

GitHub metadata is Minisign verified against the embedded public key before any
artifact is selected. Downloads must match its SHA-256 and byte size. Extraction
accepts ordinary files and directories only and rejects traversal, links, aliases,
duplicate paths, and oversized archives. Engines activate with a same-filesystem
rename after validation; process-safe standard-library locks serialize installs.
Interrupted staging directories cannot be selected as engines.

Self-update verifies and executes a staged version check before replacement. It
saves a verified backup and `uapkg-update.json` first. The `self-replace` crate
handles running executable replacement and its Windows cleanup helper. A failed
post-replacement check restores the backup. Normal startup recovers interrupted
transactions. If an interruption leaves the normal executable unavailable, run
the adjacent `uapkg.exe.backup.exe` on Windows or `uapkg.backup` on Unix to trigger
recovery, then run the normal launcher again.

The `development` Cargo feature permits a local development receipt with absolute
Node, CLI entrypoint, and checkout paths. Normal commands execute the checkout
directly without resolving project pins or downloading releases. Explicit version
management can still install release engines. An explicit version override is
rejected for such a binding; use an official launcher to exercise release pins.
