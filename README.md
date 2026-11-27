# uapkg

A plugin manager for Unreal Engine plugins.

The native `uapkg` launcher selects the CLI version pinned by a game project's
`uapkg.json`. Download the launcher and its bundled CLI from a CLI release on
[GitHub Releases](https://github.com/uapkg/uapkg/releases). See
[installation, version selection, and updates](docs/launcher.md).

`@uapkg/cli` is the TypeScript engine package. It does not register a command;
installing it globally with npm does not install the launcher.

## Plugin installation and updates

UAPKG waits three days before automatically selecting a newly published plugin version.
To change the window, run `uapkg config set packages.resolution.minimumReleaseAge 12h --global`.
Durations accept weeks, days, hours, minutes, and seconds in descending order (for example, `1d12h`).
Use `0` to disable the cooldown.

`uapkg add mesh` selects the highest stable version that meets the minimum age and works with
your project's other plugins. The same cooldown applies to dependencies introduced by Mesh.
If a newer compatible release is held back, the CLI shows which version it selected and when
the newer release reaches the minimum age.

Use `uapkg add mesh@1.2.3` to request that exact release immediately. A range such as
`^1.2.3` also allows its explicitly declared minimum, `1.2.3`. To opt out for new plugins and
their exclusively new dependencies, run
`uapkg config set packages.resolution.applyReleaseAgeToNewPackages false --global`.
`uapkg install` reuses compatible locked versions regardless of age.

`uapkg update mesh` updates Mesh and changes other locked dependencies only as required.
Use `uapkg update mesh --recursive` to check its dependencies for optional upgrades, or
`uapkg update` to check the whole project. The update summary lists releases held back
by age. Add `--ignore-release-age` to bypass the cooldown for that command.

UAPKG enables direct Unreal dependencies in the writable project or plugin descriptor.
Package-authored host integration and postinstall hooks require permission by default.
For example, `uapkg permissions approve mesh --capability integration` approves Mesh's
integration from `default`. Repeat the original install command to apply it. For authoring,
see the [integration package](packages/uapkg-integration/README.md).

## Prerequisites

- [Git](https://git-scm.com/)
- [Vite+ (`vp`)](https://viteplus.dev/guide/) installed globally
- [Rustup](https://rustup.rs/) for building the native launcher

Node.js and pnpm do not need separate global installations. During the initial
`vp install --frozen-lockfile`, global `vp` reads `.node-version` and
`packageManager`, provisions Node.js 26.13.1 and pnpm 11.22.0, and performs the
install. After that, `vp` automatically uses the repository's local Vite+
toolchain.

## Setup

```sh
git clone https://github.com/uapkg/uapkg.git
cd uapkg
vp install --frozen-lockfile
vp hooks status
```

The install lifecycle configures the committed Vite+ hooks. If hooks were
disabled locally, restore them with `vp hooks enable --hooks-dir .vite-hooks`.

Use `vp env doctor` to diagnose runtime declarations and `vp toolchain` to see
the selected local tool versions.

## Validation

```sh
vp check
vp test run
vp run launcher:format:check
vp run launcher:lint
vp run launcher:test
```

`vp check` runs Oxfmt, Oxlint, and type-aware TypeScript checks. The pre-commit
hook runs `vp staged`, limiting fixable checks to staged files.

## Builds

The root build compiles the TypeScript engine and Rust launcher. It preserves
build metadata, profile isolation, and artifact verification while using
`vp pack` for package compilation. It defaults to a development-stamped build:

```sh
vp run build
vp run build -- --production
```

The development workflow is available through the root tasks:

```sh
vp run build:link
vp run build:watch
vp run build:status
vp run build:unlink
vp run build:clean
```

See [the development-build tooling guide](tools/dev-build/README.md) for build
modes, global linking, profiles, cleanup, and verification behavior. See
[the consumer-bundle guide](tools/consumer-bundle/README.md) when another
repository needs unreleased UAPKG workspace packages.
