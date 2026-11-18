# Release catalog

UAPKG publishes the CLI and launcher independently. Native artifacts live in the
public `uapkg/uapkg` GitHub repository. The `catalog-release` branch records completed
releases. `registry-infra` generates and signs the public metadata at
`https://releases.uapkg.dev`, including download redirects to those GitHub assets.

The executable contract is `tools/release/ReleaseContract.ts`. Shared fixtures in
`tools/release/fixtures` are consumed by TypeScript and Rust tests. Their public keys
are test keys and must never be used for a production release.

## Identities and paths

Products are `cli` and `launcher`. Their versions are independent canonical SemVer
strings. Stable versions and numbered `alpha.N`/`beta.N` previews are supported;
leading `v`, ranges, nightly and RC selectors are not. Build metadata is preserved.
Bare `X.Y.Z-alpha` and `X.Y.Z-beta` are reserved selectors, not publishable versions.
Ordinary package-version schemas retain their own behavior.

Current file identifiers are `win-x64`, `win-arm64`, `darwin-x64`,
`darwin-arm64`, `linux-x64`, `linux-arm64`, and `linux-x64-musl`. Every new producer
release has all seven. Unsuffixed Linux targets require glibc; the musl target
supports Alpine x64. All current architectures are 64-bit.
An identifier expands to `uapkg-{product}-{version}-{platform}.tar.gz`.
The GitHub tags are `@uapkg/cli@{version}` and `uapkg-launcher@{version}`.

Historical receipts keep their original six identifiers, including `win32-x64`
and `win32-arm64`, and have no musl archive. Readers accept either complete
historical or current matrix. Producers require the current seven and reject
mixed or incomplete matrices. The union of nine recognized historical/current
strings is not a publication matrix. Immutable artifacts, descriptors, receipts,
checksum bytes and signatures are never renamed. The examples below describe
historical releases, whose original identities remain valid for catalog browsing.

The canonical archive URL is
`/{product}/{version}/uapkg-{product}-{version}-{platform}.tar.gz` on the releases
site. It redirects to the corresponding GitHub Release asset. The version directory
also exposes `SHASUMS256.txt` and `SHASUMS256.txt.minisig`.

`SHASUMS256.txt` is UTF-8 text with one line per archive: 64 lowercase SHA-256 hex
characters, two spaces, the canonical archive basename, and LF. Duplicate names,
missing files, unknown files and path components are invalid. A final LF is required.
No published bundle, `release.json`, per-alias document, archive-size field, npm
metadata, LTS field or codename is part of this protocol.

## Durable publisher records

The catalog branch stores exactly these files for each completed release:

```text
cli/1.6.0/entry.json
cli/1.6.0/SHASUMS256.txt
cli/1.6.0/SHASUMS256.txt.minisig
launcher/0.2.0/entry.json
launcher/0.2.0/SHASUMS256.txt
launcher/0.2.0/SHASUMS256.txt.minisig
```

```json
{
  "schemaVersion": 1,
  "product": "cli",
  "version": "1.6.0",
  "publishedAt": "2026-11-15T12:34:56Z",
  "tag": "@uapkg/cli@1.6.0",
  "files": ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]
}
```

`publishedAt` is the original full UTC GitHub publication timestamp, not the build
or catalog retry time. Release identity, publication time, original files, and
checksum/signature bytes are immutable. Only the optional `yanked` and
`quarantined` status objects may change. Historical records remain after previews
disappear from the public index. The branch contains no binaries, credentials or
private signing keys.

The publisher downloads and verifies every intended GitHub asset before committing
this record. The catalog commit is its final publication action. It starts from
the current branch head and retries bounded non-force pushes when another product
publishes concurrently. It does not deploy the website or call infrastructure
workflows. A failed catalog commit can be retried from the existing GitHub assets
without rebuilding them.

## Public documents

Each product has an `index.json` and an independent `replacements.json`, each with
its own adjacent `.minisig`. Index aliases point directly to a listed exact release;
alias chains are invalid.

```json
{
  "schemaVersion": 1,
  "product": "cli",
  "aliases": { "latest": "1.6.0", "1.7.0-beta": "1.7.0-beta.2" },
  "releases": [
    {
      "version": "1.7.0-beta.2",
      "date": "2026-11-15",
      "files": ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]
    },
    {
      "version": "1.6.0",
      "date": "2026-11-14",
      "files": ["win32-x64", "win32-arm64", "darwin-x64", "darwin-arm64", "linux-x64", "linux-arm64"]
    }
  ]
}
```

`date` is the UTC date of publication. `latest` selects the greatest stable SemVer.
A preview alias follows the greatest numbered preview of the same stage and base,
then its matching stable release. Exact numbered previews remain exact unless a
published replacement or release status redirects them.

```json
{
  "schemaVersion": 1,
  "product": "cli",
  "replacements": { "1.6.0-beta.1": "1.6.0" }
}
```

Only an exact preview to its same-base stable version is valid. The infrastructure
builder de-indexes previews and publishes replacements on a build at least 14 days
after their matching stable publication. Timely deadline-triggered builds are
separate future work. The launcher does not calculate this interval, interpret a
deadline, reject old policy by age, or infer replacement from a missing entry/404.
Published metadata remains authoritative even when stale.

### Yanked and quarantined releases

Catalog entries and public releases can contain either or both of these objects:

```json
{
  "yanked": { "at": "2026-11-18T12:34:56Z", "reason": "Regression in version selection" },
  "quarantined": { "at": "2026-11-18T13:00:00Z", "reason": "Unsafe binary" }
}
```

Status timestamps are full UTC ISO 8601 timestamps and reasons must be nonblank.
Readers accept omitted or null statuses; writers omit nulls. Each status is
independent. Removing one does not remove the other.

Neither status is an eligible resolution. Stable releases fall back to the
greatest lower healthy stable version available for the platform. Numbered
previews fall back within the same base version and alpha/beta stage. Existing
preview replacements apply first, so a retired preview's stable destination uses
the stable fallback rule. No eligible predecessor means resolution fails. Build
metadata does not make a release an earlier version. Configured selectors and
project pins keep their original values.

Yanked releases retain their published files and local caches. Quarantined
releases remain in the index with `files: []`; their original files remain in the
catalog entry. The launcher refuses acquisition and execution and removes managed
cached copies across platforms. Failed removal never permits execution and is
retried on a later invocation. Existing processes are not terminated. Quarantined
preview records remain in the index even after ordinary preview retirement so
clients can learn the status of old cached copies.

The releases site returns `410 Gone` for quarantined archive URLs, while keeping
release pages and original signed checksums available. GitHub Release assets are
not removed. Yanked archive URLs remain downloadable. Unquarantine restores the
original files without rebuilding or changing signed artifacts.

Both product indexes are checked at most once every 24 hours during released
launcher invocations, regardless of pins or automatic-update settings. Known
verified statuses apply on every invocation, including offline operation. A
flagged standalone launcher must replace itself with healthy `latest` before
running ordinary commands, even when automatic updates are disabled. A
package-managed launcher instead requires updating through its owner. Identity
probes remain available for replacement verification; development bindings do
not use published-release policy.

`latest` preserves update-tracking intent. Eligible commands check the global CLI
for a new stable release at most once every 24 hours and advance its active
version after verifying and installing the update. The configured selector and
project pins keep their values. Set `launcher.autoCLIUpdate` to `false` to receive
notices and install updates manually. Offline or site-unavailable operation uses
the last verified metadata and installed versions. Known replacements apply, and a
required version missing locally fails clearly. Preview replacement notices report
the requested and resolved versions on stderr.

## Signing and trust

UAPKG's existing artifact key signs exact `SHASUMS256.txt` bytes with Minisign.
The public key in [`release-signing.pub`](release-signing.pub) is embedded in
normal launcher builds. The private
`UAPKG_RELEASE_SECRET_KEY` is available only to the native publication job.

Infrastructure uses a **distinct** private key for generated indexes and replacement
documents. The public key in
[`release-catalog-signing.pub`](release-catalog-signing.pub) is embedded in
normal launcher builds. A metadata key cannot
authorize an archive, and an artifact key cannot authorize an alias or replacement.
All signatures include Minisign's trusted-comment signature; changing whitespace or
JSON formatting changes signed bytes. Clients authenticate a document before using
its contents and authenticate checksums before trusting downloaded archives.

Local launcher builds use these tracked trust anchors without environment-variable
setup. Pull-request checks, push CI, and release preflight require
`UAPKG_RELEASE_PUBLIC_KEY` and `UAPKG_CATALOG_PUBLIC_KEY` to match the tracked keys.
The pull-request check uses trusted base-branch code to compare only the proposed
public-key files, including for contributions from forks. It does not execute
pull-request code or use signing secrets.

Never rotate either production key by changing an unsigned endpoint. With the current
single-key trust anchors, coordinate a launcher bootstrap carrying the replacement
public key before switching that signer; old launchers require manual replacement.
Preserve historical artifacts, checksums and their original signatures. An automated
overlapping-key rotation would require its own explicit protocol and implementation.

## Publishing

Use `vp run change` to record a `minor` or `patch` change. The `@uapkg/*` packages
form the fixed CLI/library family. The private `uapkg-launcher` Changesets target
represents the whole launcher Cargo workspace, including `uapkg-slim-config`, and
versions independently of the CLI. Its version comes from `launcher/package.json`;
all launcher crates inherit the synchronized Cargo workspace version. Individual
crates do not need `package.json` files, and the launcher target is not published
to npm.

`vp run version:packages` applies pending changesets and synchronizes the launcher
Cargo workspace and lockfile. For synchronization without consuming changesets,
use `vp run launcher:version:sync`. `vp run launcher:version:check` verifies the
committed versions without changing files and runs in CI and release preflight.

1. Run `vp run version:packages`, then commit the generated version, changelog, and
   lockfile changes and push them to `main`.
2. Run the `Release` workflow manually with the exact product/version. It never
   creates a version PR. npm packages publish independently when the product is
   `cli`; native publication has no npm-existence or npm-success gate.
3. For a CLI release, supply an already published launcher version for all-seven-platform
   terminal qualification. General CI can qualify CLI runtime candidates without a
   paired published launcher.
4. The workflow publishes immutable assets and checksums, verifies the remote bytes,
   and commits `catalog-release`. A complete existing release skips native rebuilding
   on retry. A partially uploaded release requires the original retained artifacts;
   differing rebuilt bytes are rejected rather than overwritten.
5. The repository push webhook informs infrastructure. A missed webhook is recovered
   by manually running the infrastructure site workflow. There is no source recovery
   scan, catalog polling/reconciliation timer or GitHub Actions schedule.

The CLI workflow never rebuilds a launcher. The launcher workflow does not build a
CLI or require npm publication. Node/Vite+ are still repository packaging tools.
The independent terminal harness assembles temporary test installations from a
verified launcher and the CLI candidate; these are not published bundles.

### Changing release status

Run the `Release status` workflow on `main` with `product` (`cli` or `launcher`),
an exact published `version`, and `operation` (`yank`, `unyank`, `quarantine`, or
`unquarantine`). Supply a reason for yank/quarantine. Only GitHub account ID
`10104630` may dispatch or rerun this workflow; every mutation attempt verifies
both actor identities.

The workflow changes only the selected status key in the existing catalog entry.
Repeating the same reason preserves its timestamp; clearing an absent status does
nothing. It does not upload, rebuild, delete, or resign artifacts. The normal
catalog webhook rebuilds and deploys the signed public metadata. If that webhook
is missed, run the infrastructure `Releases site` workflow on `main`.

Release a launcher that understands these fields before setting any status.
Older launchers reject annotated indexes and require a manual upgrade. Ensure
launcher recovery targets also understand the updated index. Deploying this
capability does not itself yank or quarantine an existing release.
