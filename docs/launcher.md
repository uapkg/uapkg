# Installing and managing UAPKG

`uapkg` is a native launcher. It selects and starts a versioned TypeScript CLI;
package operations and authentication remain implemented in TypeScript.

## Install

Choose an `@uapkg/cli@<version>` release on
[GitHub Releases](https://github.com/uapkg/uapkg/releases) and download the
full bundle for your platform. Supported targets are Windows, macOS, and glibc
Linux, each on x64 and ARM64. Alpine/musl Linux is not a supported target.

Extract the entire archive into a user-writable directory and add that directory
to `PATH`. Keep `uapkg` (`uapkg.exe` on Windows), `uapkg-install.json`, and the
`cli` directory together. The bundle includes its default CLI and Node runtime,
so it can run offline without installing Node, npm, or Rust.

`@uapkg/cli` on npm contains the engine. It has no `bin` registration; `npm
install -g @uapkg/cli` does not install the `uapkg` command. The launcher itself
is distributed only through GitHub Releases in this version.

## Pin a game project's CLI

Add an exact CLI version to the game's `uapkg.json`:

```json
{
  "name": "my-game",
  "version": "0.1.0",
  "kind": "project",
  "uapkgVersion": "1.5.0"
}
```

Use a published version in place of the example. Ranges such as `^1.5.0`,
prefixes such as `v1.5.0`, and tags such as `latest` are not project pins.
Explicit prereleases are allowed. `uapkg init` records the executing CLI version
when it creates a game project; it does not add a pin to plugin manifests.

The launcher searches upward from the current directory for the nearest game
project manifest. It passes over plugin manifests. A nearer project without a
pin uses the global default, even if an outer project has a pin.

One selected CLI handles the game's complete dependency graph. Plugin and
dependency manifests never choose another CLI. Pin discovery does not change
the working directory or the command's existing package-root behavior.

| Command                                    | CLI selection                         |
| ------------------------------------------ | ------------------------------------- |
| `login`, `logout`, `whoami`                | Global default                        |
| Other commands, including unknown commands | Project pin, otherwise global default |
| `--cli-version <exact>`                    | Explicit version                      |
| Launcher/version management                | Handled by the Rust launcher          |

Global authentication commands still read the normal CLI configuration, including
project registry selection. `--global` on a configuration command refers to
configuration scope, not CLI-version selection.

```sh
uapkg version current
uapkg --cli-version 1.5.0 install
uapkg install --cli-version 1.5.0
uapkg --version --cli-version 1.5.0
uapkg install --offline
```

Place launcher options anywhere after `uapkg`, before or after the subcommand.
Both `--cli-version <exact>` (also `--cli-version=<exact>`) and `--offline` are
consumed by the launcher. Other arguments keep their order and values.
A standalone `--` ends launcher option parsing: it and all following arguments
are passed to the CLI unchanged. For example, `uapkg install -- --offline` passes
the literal `--offline` argument to the CLI instead of enabling launcher offline mode.
`uapkg --version` reports the selected CLI version; `uapkg launcher --version`
reports the launcher version.

## Manage versions and sources

```sh
uapkg version install 1.5.0
uapkg version install latest
uapkg version list
uapkg version default 1.5.0
uapkg version default latest
uapkg config get launcher.cliSource --global
uapkg config set launcher.cliSource npm --global
uapkg config set launcher.cliSource github-releases --global
```

`latest` resolves a stable version during that management command. The stored
default remains an exact version. Normal commands do not advance it.
`version default` installs the requested version, then asks the TypeScript CLI to
save `launcher.defaultCliVersion` through its normal global configuration command.
You can also set that exact version with `uapkg config set
launcher.defaultCliVersion <version> --global`; its installation happens when needed.

The default source, `github-releases`, installs standalone implementations with
their own runtime. The optional `npm` source installs the exact engine package
into a private cache. It requires Node `>=26.0.0` and npm `>=11.12.1`, subject to
the selected engine's declared `engines` ranges. Cached npm engines need Node;
npm is needed when installing or repairing them. Runtime versions are ranges,
while the UAPKG CLI version remains exact.

Each source has separate version/platform cache entries. Switching source keeps
the selected version and obtains it from the new source. UAPKG never substitutes
another source or version when the requested artifact is unavailable.

Launcher settings are part of the shared `@uapkg/config` schema, under `launcher`
in `~/.uapkg/config.json` (or `~/.uapkg-development/config.json` during development):

```json
{
  "launcher": {
    "cliSource": "github-releases",
    "defaultCliVersion": "1.5.0"
  }
}
```

The launcher reads only this global object's values. It does not resolve local
configuration files or project overrides. Normal TypeScript config commands keep
their existing scope and layering rules; use `--global` to change the launcher's
selection. If `cliSource` is absent, it uses `github-releases`. If
`defaultCliVersion` is absent, it uses the installation bundle's default.

Configuration commands require a usable CLI. Before one is installed, edit the
global JSON file manually or install a full bundle. Rust never writes this
configuration, and there is no `uapkg launcher config` command. Installation
ownership remains in the installation receipt.

## Offline execution and recovery

Bundled and completely installed versions run without a metadata request.
`--offline` forbids fetching an uncached version. Install required versions before
disconnecting or preparing an offline CI environment.

Downloads are staged, verified, and activated only when complete. Interrupted
downloads do not replace working versions. If a cached installation is damaged,
the error identifies its directory; remove that version's directory and rerun
`uapkg version install <version>` while online. Do not delete the whole UAPKG
profile to repair an engine: it also contains configuration and authentication
metadata.

GitHub downloads require a signed release descriptor and matching artifact hash.
The [release signing public key](release-signing.pub) is also available for manual
verification with `minisign -Vm release.json -p release-signing.pub`.
The archive contains `engine.json`, which records the exact CLI version, platform,
runtime executable, and arguments. The signed archive hash authenticates this
execution metadata before extraction or execution.
npm downloads require matching tarball integrity and a frozen runtime lock.
Installation does not execute npm lifecycle scripts. Credential-store access
remains protected by the operating system; packaging adds no plaintext fallback.

## Update the launcher

```sh
uapkg self-update
```

Launcher updates are explicit and leave project pins and the default CLI version
unchanged. Installation ownership controls the update method. Standalone
installations can replace themselves; package-manager-owned installations print
the appropriate upgrade instruction. Choosing npm as the CLI source does not
make npm the launcher owner.

Windows updates retain a backup and recovery state during replacement. If an
update fails, follow the reported recovery path. Re-extracting the same full
bundle into its installation directory is also possible without deleting profile
state. Do not copy an installation receipt from another distribution method.

## Development

Use `vp run build` for a development build or `vp run build -- --production` for
a production build. Cargo runs from `launcher/`, where Rustup reads the exact
Rust toolchain pin. `vp run launcher:format`, `launcher:lint`, and `launcher:test`
provide Rust's standard formatting, linting, and tests.

`build:link` installs the native launcher in `~/.uapkg-development/bin` and records the local
checkout, engine entrypoint, and Vite-managed Node executable. This explicit
development installation runs local code instead of downloading project pins.
The engine retains its development banner, development service endpoints, and
`~/.uapkg-development` profile. Release launchers reject development bindings.

`build:watch` rebuilds the local engine and launcher. Failed builds leave the
previous launcher installed. `build:unlink` restores the saved installation only
while this checkout still owns it. `build:status` checks paths and command
precedence, including PowerShell resolution. See the
[development tooling guide](../tools/dev-build/README.md).

Linking adds the development directory to your user PATH when absent and records
its prior state in the snapshot. Unlink removes only the entry added by that link.
Pre-existing entries, production paths, and unrelated PATH edits are preserved.
Rebuilds retain the original snapshot baseline. Open a new terminal after a PATH
change; the running tool cannot update its parent terminal's environment.

Remove an existing npm/pnpm development link with the package manager that owns
it, for example `pnpm remove -g @uapkg/cli`. Check `Get-Command uapkg -All` and
`where.exe uapkg` for old `.ps1`/`.cmd` wrappers that still shadow the native binary.
`build:link` manages the development PATH entry; open a new terminal afterward.
The new tooling does not create or maintain command wrappers.

## Diagnostic reports

Run `uapkg --debug-info` and copy its output into a bug report. It includes the
executing CLI and launcher versions, build mode, installation owner, global CLI
default, nearest project pin, explicit version override, selection reason, CLI
source, and runtime. System details include OS, CPU, memory, shell, and relevant
tools found on PATH. The running Node version is reported separately from Node
found on PATH, since standalone CLIs carry their own runtime.

`Launcher path` identifies the running launcher executable. `CLI path` identifies
the selected JavaScript entry point, or the CLI executable for a SEA build. Both
are full paths, including the home directory. When the CLI runs directly without
the launcher, its launcher path is reported as unavailable.

```sh
uapkg --debug-info
uapkg install --debug-info
uapkg --debug-info --cli-version 1.5.0
```

The flag prints the report and exits; it does not run the requested CLI command.
It follows the launcher's version selection rules, including project pins and
explicit overrides. Diagnostics do not download missing CLI versions. If the
selected CLI is unavailable, use `--cli-version` with an installed version to
collect a report. Development bindings report that local checkout execution
overrides project selection.

The report uses a fixed list of fields. It does not print credentials, environment
variables, full configuration, registry URLs, or command arguments. System probes
are time-limited and cannot enable Corepack downloads. Unavailable information is
marked in the report instead of preventing the rest from being collected.

## Release preparation

The native workflow builds all six targets. It packages the same bundled engine
and frozen dependency closure used for npm. The published engine carries
`dist/runtime-lock.json`; the launcher stages it as `package-lock.json` for
`npm ci`, because npm 12 no longer consumes published shrinkwrap files.

Each native runner tests a private-runtime bundle and a Node SEA candidate.
The runtime checks exercise the packaged launcher and CLI in a real terminal,
including interactive initialization, Ctrl+C, and exit-status preservation.
CI selects SEA only when all six candidates pass, including their credential-store
tests. Otherwise it selects private-runtime bundles for every platform. The
selection is recorded in `packaging-evidence.json`; installed launchers do not
switch packaging formats or sources as a recovery mechanism.

```sh
vp run build -- --production
vp run release:prepare
vp run release:smoke-npm -- --package packages/uapkg/package
vp run release:native -- --output dist/native --launcher <release-launcher-path>
vp run release:smoke-native -- --engine dist/native/cli --keyring
```

The release workflow gathers verified artifacts, signs `release.json`, publishes
the npm packages through Changesets, and attaches native assets to the exact
`@uapkg/cli@<version>` release. It never uses GitHub's unfiltered latest-release
endpoint. The launcher has its own version; a launcher-only fix currently travels
with a CLI patch release. Existing versioned assets must not be overwritten.
Attachment checks the exact npm version up to 31 times, ten seconds apart, to
allow five minutes for registry propagation. Other lookup errors fail immediately.
If the version remains unavailable, the workflow fails with instructions to
confirm publication and retry with the retained artifacts.
Attachment can resume after a partial upload: it verifies existing assets and
uploads only missing files, with the signed catalog last. Retry using the retained
`native-release` build artifact. If rebuilding changes published bytes, use the
original artifacts or publish a new version; the retry refuses to overwrite them.

Before publishing, configure:

- Repository variable `UAPKG_RELEASE_PUBLIC_KEY`: the base64 Minisign public key.
  It is embedded in every production launcher.
- Repository secret `UAPKG_RELEASE_SECRET_KEY`: the matching unencrypted Minisign
  secret-key file, protected by GitHub's secret storage and release permissions.
- Existing npm publishing credentials (`NPM_TOKEN`).

Generate the signing key outside the repository with Minisign `-G -W`; retain a
secure backup. Do not put a private key in source or artifacts. Verification-only
builds may omit the key, but those binaries cannot fetch signed GitHub releases.
The publishing command refuses to publish without a complete six-target catalog,
matching archive hashes, and a signature verified with the configured public key.

Signing-key rotation requires a launcher release that trusts the replacement key
before retiring the old one. No GitHub secrets or releases are changed by building
or testing locally.
