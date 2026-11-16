# Installing and managing UAPKG

`uapkg` is a native launcher. It selects and starts the TypeScript CLI; package
operations and authentication remain in the CLI.

## Install

Choose a launcher version from [UAPKG releases](https://releases.uapkg.dev/launcher/).
Download `uapkg-launcher-<version>-<platform>.tar.gz` and the accompanying
`SHASUMS256.txt` and `SHASUMS256.txt.minisig`. Verify the checksum signature with
[the artifact signing key](release-signing.pub), then verify the archive's SHA-256.
For example, `minisign -Vm SHASUMS256.txt -p release-signing.pub` verifies the
checksum list. The site redirects artifact downloads to GitHub Releases.

Supported platforms are `win32-x64`, `win32-arm64`, `darwin-x64`, `darwin-arm64`,
`linux-x64`, and `linux-arm64`. Linux requires glibc; Alpine/musl is not supported.
Extract the launcher into a user-writable directory and add that directory to
`PATH`. Then choose the initial CLI:

```sh
uapkg version default latest
```

Launcher and CLI archives are separate. Each CLI archive includes its runtime;
Node.js, npm, and Rust are not required on the user's machine. The launcher
installs the CLI in `~/.uapkg/engines/<version>/<platform>/`.

`@uapkg/cli` continues to be published to npm for package consumers. It has no
`bin` registration, and npm is not a launcher download source.

## Select a CLI

A game's `uapkg.json` can select a CLI version:

```json
{
  "name": "my-game",
  "version": "0.1.0",
  "kind": "project",
  "uapkgVersion": "1.6.0"
}
```

Selectors accept exact stable versions, exact numbered alpha/beta versions,
`latest`, and a base-scoped alias such as `2.0.0-alpha` or `2.0.0-beta`.
Ranges, `v` prefixes, and unscoped `alpha`/`beta` are unsupported.
`uapkg init` records the executing exact CLI version for new game projects.

The launcher searches upward for the nearest game project, skipping plugin
manifests. An unpinned project uses the global default. One CLI handles the
complete dependency graph; dependency manifests do not select another CLI.

| Command                              | CLI selection                                      |
| ------------------------------------ | -------------------------------------------------- |
| `login`, `logout`, `whoami`          | Global default                                     |
| Other CLI commands                   | Nearest project selector, otherwise global default |
| `--cli-version <selector>`           | Explicit override                                  |
| `launcher`, `version`, `self-update` | Handled by the launcher                            |

```sh
uapkg version install 1.6.0
uapkg version install latest
uapkg version default latest
uapkg version current
uapkg version list
uapkg install --cli-version 2.0.0-alpha
uapkg install --offline
```

Launcher options can appear before or after the command. `--cli-version=value`
also works. A standalone `--` ends launcher option parsing and preserves all
following arguments. `uapkg --version` reports the CLI version;
`uapkg launcher --version` reports the launcher version.

`version default` installs the selected CLI and delegates the configuration
write to that CLI. The global configuration preserves the requested selector:

```json
{
  "launcher": {
    "defaultCliVersion": "latest"
  }
}
```

The launcher reads `~/.uapkg/config.json`; local CLI configuration does not change
this default. The installation receipt may supply a default when configuration
has none. `--global` on a CLI configuration command controls configuration scope,
not version selection.

`latest` remembers an installed exact version separately. Ordinary commands
continue to use it and report available stable updates. Run `uapkg version install
latest` or `uapkg version default latest` to advance it explicitly.

## Preview versions

`2.0.0-alpha` follows the published alpha alias for that base version, and
`2.0.0-beta` follows its beta alias. Exact previews such as `2.0.0-alpha.1` remain
exact until the release site publishes a signed replacement mapping. A replacement
can only select the stable version of the same base, such as `2.0.0`.

The launcher never infers promotion from a missing release, a 404, or elapsed time.
It uses the release site's published policy. A retired-preview notice displays
both the requested and resolved version; project manifests are never rewritten.
Update and promotion notices go to stderr at startup and normal CLI completion.
Older CLIs may show only the startup notice. Forced termination cannot guarantee
a completion notice.

## Offline execution and recovery

`--offline` (or `UAPKG_OFFLINE=1`) prohibits launcher network requests. Installed
exact stable CLIs run locally. Preview and alias selection uses the last verified
metadata and remembered resolution when the site is unavailable. Metadata does
not expire because a local clock crosses a retirement deadline. If known metadata
requires a replacement that is not installed, the launcher fails instead of
running the retired preview. Install required versions before disconnecting.

The launcher verifies `index.json` and `replacements.json` with its embedded
catalog key. It verifies each archive against `SHASUMS256.txt`, signed with a
separate artifact key. Content-Length is optional and is not integrity evidence.
Downloads and extraction have size bounds. Installation uses staging, per-version
locks, and atomic activation; interrupted downloads leave existing versions intact.

A damaged cache error identifies the version directory to remove and reinstall.
Do not delete the whole profile: it also contains configuration and credentials.

The old `launcher.cliSource` setting is unsupported; remove that one property
from global configuration. Old source-specific `engines/npm` and
`engines/github-releases` directories are ignored and may be removed manually.
Cached npm engines and bundled-engine receipts are not migrated or executed.
For the distribution cutover, install the new standalone launcher archive and
select its default CLI; an older launcher cannot discover this distribution format.
Keep unrelated configuration and authentication state.

## Update the launcher

```sh
uapkg self-update
uapkg self-update 0.2.0
uapkg self-update 0.3.0-beta
```

Self-update uses the independent launcher catalog and the same selector and
published replacement rules. It leaves CLI defaults and project selectors intact.
A `latest` self-update remembers tracking intent and later commands report newer
launcher versions; installing them remains explicit.

Standalone launchers can update themselves. npm-, WinGet-, Homebrew-, Scoop-,
and development-owned installations must use their owner's update method.
An installation receipt records ownership independently of artifact hosting.

Updates verify the staged executable's version before replacement. A verified
backup and transaction journal support recovery after interruption, including
Windows executable replacement. If the normal executable is unavailable, run
`uapkg.exe.backup.exe` on Windows or `uapkg.backup` on Unix, then retry the normal
launcher. Re-extracting an authenticated launcher archive is also possible without
removing profile state. Do not copy receipts from another distribution method.

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
default, nearest project pin, explicit version override, selection reason, and runtime. System details include OS, CPU, memory, shell, and relevant
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

CLI and launcher releases use independent version numbers, Git tags, archives,
and signed checksums. A launcher change requires a new launcher version; a
previously published product/version/platform archive is never rebuilt in place.
CLI releases continue their normal npm publication separately from native release
availability. The catalog publisher verifies artifacts and writes the public
`catalog-release` branch. Registry infrastructure builds the signed releases site.

Native release qualification exercises the actual packaged runtime in a terminal,
including interactive input, Ctrl+C, and exit-status preservation. The release
pipeline uses the private Node runtime unless the SEA candidate passes the
required qualification across supported targets. Runtime selection is made at
publication; the installed launcher never falls back to npm or another format.
