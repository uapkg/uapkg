# Development builds

Run repository tooling through Vite+ (`vp`). Install Rust through rustup; Cargo
uses the toolchain pinned in `launcher/rust-toolchain.toml`. The native Rust
launcher is the only executable named `uapkg`. The npm package is a TypeScript
engine and does not register a command.

## Commands

```sh
vp run build
vp run build -- --production
vp run build:link
vp run build:watch
vp run build:status
vp run build:unlink
vp run build:clean
vp run clean:all
```

- `build` compiles TypeScript packages and the Rust launcher. Development is the
  default; `--production` builds both for production. It does not install a
  command or change a user profile.
- `build:link` builds a development engine and launcher, then installs the native
  command in `~/.uapkg-development/bin`. Its adjacent `uapkg-install.json` binds the launcher
  to this checkout's engine and the absolute Vite-managed Node executable.
  It adds that directory to your user PATH if missing and records the prior PATH
  state in the restore snapshot. Existing entries keep their spelling and order.
- `build:watch` links once, then watches TypeScript and Rust source inputs.
  Rebuilds run in sequence, and generated outputs do not trigger another build.
  A Rust compilation failure leaves the installed launcher intact.
- `build:status` reports installation ownership, engine and Node paths, both
  profile roots, and actual command resolution. On Windows it checks PowerShell
  as well as CMD resolution.
- `build:unlink` restores the exact prior native executable and receipt, or
  removes this checkout's installation when no prior installation existed.
  It removes the PATH entry only when this link added it. Pre-existing entries
  and unrelated PATH edits made after linking are preserved.
- `build:clean` removes package `dist`, coverage, TypeScript build-info, Vite Task
  cache, `launcher/target`, the prepared `packages/uapkg/package` engine, and
  `dist/native`, `dist/native-artifacts`, and `dist/release`. Other root `dist`
  content is retained. It does not unlink the installed command.
- `clean:all` unlinks this checkout, removes build/install artifacts and local
  pnpm stores, and prunes pnpm store metadata. User profiles are retained.

PATH changes take effect in newly opened terminals; a child process cannot change
the terminal that launched it. Windows linking updates only the current user's
PATH and notifies Windows of the change. On bash, zsh, and fish it adds a marked
block to the shell profile, and unlink removes only an unchanged block it added.
Existing entries are kept in place; `build:status` reports if another command takes
precedence. No shell, CMD, or PowerShell command wrappers are created.
Development linking no longer installs or links a global npm package.
An older npm installation can still take precedence, particularly its `.ps1`
shim in PowerShell. Remove that installation using the package manager that
created it, then check `build:status`. The tooling does not remove old or
unrelated global commands automatically.

## Ownership and recovery

Use `vp run build:link -- --force` to save and temporarily replace an existing
native installation in the development bin directory. Backups and ownership hashes are kept under
`tools/dev-build/.state/native-uapkg`. Repeated linking preserves the original
backup, including when `--force` is supplied.
The snapshot also preserves the first link's PATH baseline across rebuilds and
repeated links. It records ownership of the development entry rather than saving
and later overwriting the entire PATH. An unlink without an owned snapshot makes
no PATH changes. Production's `~/.uapkg/bin` is never managed by development linking.

Link and unlink refuse to overwrite an installation changed by another owner.
The restore snapshot remains available for review. There is no force-unlink
option. Close running UAPKG processes if Windows prevents executable replacement
and retry. A failed receipt replacement restores the prior executable and
receipt. Do not delete the saved restore state while a development link is active.

The development launcher deliberately runs the bound local engine rather than
downloading a project-pinned release. This makes edits in this checkout visible
in other projects. Use a release launcher to test normal project pin selection.
The development launcher rejects an explicit version override rather than
silently switching to a downloaded engine.

## Profiles and trust roots

The engine stamps its build mode before loading configuration. Development
commands print `DEVELOPMENT BUILD` on stderr and use `~/.uapkg-development` for
the native installation, global configuration, registry caches, authentication
metadata, and locks. Production commands use `~/.uapkg`. Linking, unlinking,
watching, and cleaning preserve configuration, caches, and authentication data
in both profiles and leave the production executable and receipt unchanged.

Launcher settings share the profile's `config.json` with other CLI settings.
For example, `uapkg config set launcher.cliSource npm --global` selects the npm
engine source for that profile, and `uapkg config get launcher.cliSource --global`
reads it. A development checkout binding continues to execute its local engine.

Production and source execution use issuer `https://account.uapkg.dev/oauth`
and API origin `https://api.uapkg.dev`. Development builds use the corresponding
`account-dev` and `api-dev` origins. Project settings and registry metadata cannot
override those authentication endpoints. Secrets remain in the operating-system
credential store with issuer-scoped references; there is no plaintext fallback.

The default Git registry follows the build mode. Global and project registry
configuration still overrides that default. Registry clones remain lazy: build,
link, and CLI startup do not clone a registry. `uapkg registry auth` uses system
Git authentication; `uapkg login` authorizes the UAPKG control plane separately.

## Artifact verification

Vite Task derives the TypeScript dependency graph from workspace package
manifests. Pack preserves the library JavaScript/declaration tree and meaningful
source maps. Package build tasks own only their `dist` outputs. Cargo runs from
`launcher/` with `--locked`; development and production builds use separate
target directories.

CI runs installation, checks, tests, production builds, and release smoke tests.
It must not run global linking, watch, unlink, or `clean:all`. Tests for native
linking use temporary home directories and never modify a developer's command
installation.

After building the engine and a development launcher, run the executable smoke
test with its path, for example:

```sh
vp exec node tools/dev-build/runNativeSmoke.ts --launcher launcher/target/development/debug/uapkg
```

On Windows the executable ends in `.exe`. This test copies the engine into a
temporary checkout, installs only into a temporary home, and checks pin bypass,
version reporting, the development banner, both profile roots, repeated linking,
and unlinking. On Windows it also invokes `uapkg` through PowerShell and CMD and
verifies that both resolve the temporary native executable.
