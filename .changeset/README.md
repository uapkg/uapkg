# Changesets

Use only `minor` or `patch` changesets while UAPKG is in development. Breaking
changes are expected and may ship in a minor release; do not select `major` or
add compatibility layers solely to preserve semantic versioning.

Run `vp run change` with a code change and select the affected release target:

- The `@uapkg/*` packages form the fixed CLI/library family. Selecting any member
  versions the whole family together.
- `uapkg-launcher` represents the entire launcher Cargo workspace, including
  `uapkg-slim-config`. Select it for changes to any launcher crate. Its private
  `launcher/package.json` supplies the Changesets version; individual crates do not
  need their own `package.json` files. The launcher versions independently of the
  CLI/library family and is not published to npm.

Before releasing, run `vp run version:packages`. This applies pending changesets
and synchronizes the launcher version into the Cargo workspace and lockfile.
Commit the generated version, changelog, and lockfile changes and push them to
`main` before manually running the `Release` workflow with the intended product
and exact committed version. See [the release process](../docs/release-catalog.md#publishing).

Use `vp run launcher:version:sync` to synchronize Cargo version files without
consuming changesets. `vp run launcher:version:check` checks for version drift
without changing files; CI requires this check to pass.
