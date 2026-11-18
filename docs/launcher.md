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

Supported platforms are `win-x64`, `win-arm64`, `darwin-x64`, `darwin-arm64`,
`linux-x64`, `linux-arm64`, and `linux-x64-musl`. Unsuffixed Linux targets require
glibc; Alpine x64 uses the musl target. ARM64 musl is not supported. See
[platform support](platform-support.md) for runtime requirements.
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
manifests. An unpinned project uses the resolved configuration default. One CLI handles the
complete dependency graph; dependency manifests do not select another CLI.

| Command                                  | CLI selection                                             |
| ---------------------------------------- | --------------------------------------------------------- |
| `login`, `logout`, `whoami`              | Resolved configuration default                            |
| Other CLI commands                       | Nearest project selector, otherwise configuration default |
| `--cli-version <selector>`               | Explicit override                                         |
| `launcher`, `version`, `launcher-update` | Handled by the launcher                                   |

The launcher resolves the selected CLI and installs it for the current platform
when it is missing, unless `--offline` or `UAPKG_OFFLINE=1` prohibits downloads.
This applies to configuration defaults, project pins, and explicit overrides. A failed
installation does not substitute another installed version or change the default
or project pin.

```sh
uapkg version install 1.6.0
uapkg version install latest
uapkg version default latest
uapkg version current
uapkg version list
uapkg version list available
uapkg install --cli-version 2.0.0-alpha
uapkg install --offline
```

Launcher options can appear before or after the command. `--cli-version=value`
also works. A standalone `--` ends launcher option parsing and preserves all
following arguments. `uapkg --version` reports the CLI version;
`uapkg launcher --version` reports the launcher version.
`uapkg launcher --platform` reports its compiled distribution identifier.
`uapkg version current` reports the project-scoped selection, including an
explicit override, without installing it.

`version default` installs the selected CLI and delegates the configuration
write to that CLI. The global configuration preserves the requested selector:

```json
{
  "launcher": {
    "defaultCliVersion": "latest"
  }
}
```

The launcher resolves configuration in the same order as `@uapkg/config`: built-in
defaults, `~/.uapkg/config.json`, intermediary `.uapkg/config.json` files from the
nearest manifest directory toward the working directory, and the working
directory's `.uapkg/config.json`. Later valid values override earlier ones. Without
an ancestor manifest, only the working directory's local config is considered.
All three `launcher` settings support these layers. The built-in CLI default is
`latest`; installation receipts do not supply a release CLI fallback.

`version default` continues to read and write the global default. Use
`uapkg config set launcher.defaultCliVersion <selector>` to set a local default
inside a project, or add `--global` to edit global configuration. Project
`uapkgVersion` pins and `--cli-version` overrides still take precedence.
`--global` on a CLI configuration command controls configuration scope, not
version selection.

Invalid config values are ignored individually, preserving valid siblings and
earlier valid values. Warnings identify the file, scope, property, expected and
received types, and the retained value's source. Unreadable or malformed config
files warn and contribute no values. Configuration is read-only in the launcher;
all `uapkg config` commands continue to run in the TypeScript CLI. Manifest
validation and project version pins retain their existing behavior.

`latest` remembers the exact version installed in the cache. The configured default
continues to read `latest` after updates. Exact global versions and project
selectors retain their own version selection rules.

## List CLI versions

`uapkg version list` shows locally installed CLI versions for the current
platform. Selected versions appear first, in the order `global default`,
`config default` when a local or intermediary config supplies one, `project pin`,
then `cli override`. Each configured role appears once; roles
that select the same version share one row. Unset roles are omitted.

```text
1.7.0 (global default, installed)
1.7.2 (project pin, not installed) (used as alias `latest`)
1.6.0 (cli override, installed)

1.7.1
1.6.1

To see the list of available versions, run `uapkg version list available`.
```

Only selected versions show `installed` or `not installed`. The remaining rows
are installed versions, sorted by SemVer from newest to oldest. Source and
platform columns are omitted. Use `--cli-version <selector>` with `version list`
to include that override in the listing.

This listing does not contact the release site or install anything. Alias notes
identify selections made through an alias rather than an exact version. Aliases
resolve from cached metadata and remembered resolutions; an alias that cannot
be resolved locally remains visible as unresolved, for example
`latest (global default, unresolved)`. When roles share one version, alias notes
identify the role that uses each alias:

```text
1.7.2 (global default, project pin, installed) (project pin uses alias `latest`)
```

`uapkg version list available` shows up to 15 highest CLI versions available for
the current platform from the verified release index, sorted by SemVer from
newest to oldest. It includes prereleases, excludes versions with published
replacement mappings, and shows aliases associated with each listed version.
It does not show installation status or selection roles.

```text
2.0.0-alpha.2
2.0.0-alpha.1
1.9.0 (alias `latest`)
1.8.9
1.7.0
```

When more than 15 versions qualify, the listing ends with:

```text
This is a partial list. For the complete list, visit https://releases.uapkg.dev/cli
```

The available list refreshes signed release metadata when online. With
`--offline`, it uses verified cached metadata and fails if the required metadata
is unavailable. Neither listing downloads CLI binaries or changes version
selections.

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
running the retired or flagged release. Known yank and quarantine statuses also
apply to exact pins and installed caches. Install required versions before
disconnecting.

The launcher verifies `index.json` and `replacements.json` with its embedded
catalog key. It verifies each archive against `SHASUMS256.txt`, signed with a
separate artifact key. Content-Length is optional and is not integrity evidence.
Downloads and extraction have size bounds. Installation uses staging, per-version
locks, and atomic activation; interrupted downloads leave existing versions intact.

A damaged cache error identifies the version directory to remove and reinstall.
Do not delete the whole profile: it also contains configuration and credentials.

## Launcher and CLI updates

```sh
uapkg launcher-update
uapkg launcher-update 0.3.2
uapkg launcher-update 0.3.0-beta
uapkg version install latest
```

Released launcher invocations check both product indexes at most once every 24
hours, including pinned versions, diagnostics, and launcher management commands.
Eligible commands install new stable versions automatically. The original command
continues with the updated launcher or CLI. Optional update failures can retain a
healthy installed version. Offline runs use verified cached metadata; development
bindings and identity-only launcher probes skip published-release checks.

Yanked and quarantined versions are excluded from execution and resolution. A
flagged stable CLI falls back to the greatest lower healthy stable available for
the platform. A flagged preview falls back within its base version and alpha/beta
stage, after applying existing preview-retirement mappings. Configured selectors
and project pins are unchanged. Resolution fails if no eligible predecessor
exists. Yanked caches are retained; quarantined versions are removed from managed
caches across platforms. Locked files are retried later, and the flagged version
is never selected while cleanup is pending.

Use either setting to keep daily checks and install updates manually:

```sh
uapkg config set launcher.autoLauncherUpdate false
uapkg config set launcher.autoCLIUpdate false
```

These commands use normal configuration scope: local inside a project and global
outside one. Add `--global` to edit the profile's policy from inside a project.
Local and intermediary policies override the global values.

Use `uapkg config get <key>` to see the effective value. Both settings default to
`true`. They require CLI 1.7.1 or later. To edit these settings while using an
older pinned CLI, select a newer version for the config command with
`--cli-version`. Availability notices appear before and after CLI output on stderr.

`uapkg launcher-update` checks immediately and resets the launcher check interval.
It follows the independent launcher catalog and its published selectors. An
explicit exact launcher version stays selected until the next manual update.

Standalone launchers can update themselves. Use the original package manager to
update installations owned by npm, WinGet, Homebrew, or Scoop. The installation
receipt records which tool owns the launcher.

A yanked or quarantined standalone launcher must update to healthy `latest` before
ordinary commands can run, even if automatic updates are disabled. This recovery
may install an earlier version and resumes the original command after successful
replacement. Offline or failed recovery blocks ordinary commands. Package-managed
installations instead require an update through their package manager.
`launcher-update` remains available for recovery, and `launcher --version` and
`launcher --platform` remain available for replacement verification.

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

The launcher embeds a generated, launcher-only JSON Schema and its defaults from
`@uapkg/config`. Repository native build wrappers regenerate it before compiling.
`vp run launcher:schema` updates the checked-in artifact;
`vp run launcher:schema:check` checks freshness without writing. Direct Cargo
builds use the checked-in schema and do not require Node. CI checks freshness
before building native artifacts.

To build only the launcher with normal release selection and downloads, run
`vp run launcher:build` from the repository root. The executable is written to
`launcher/target/release/`. The production catalog and artifact public keys are
embedded from tracked files; no GitHub authentication or public-key environment
variables are needed. The `development` Cargo feature is not enabled.

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
explicit overrides. Diagnostics for launcher commands use the global default.
Missing selected CLIs are installed while online, and successful alias
resolutions are remembered for later invocations. Use `--offline` to require an
already installed CLI. Diagnostics skip optional upgrades and ordinary transaction
recovery, while still checking release policy and requiring recovery from a
flagged launcher. Development bindings report that local checkout execution
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
