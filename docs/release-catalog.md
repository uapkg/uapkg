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
or catalog retry time. An entry and its original checksum/signature bytes are
immutable. Historical records remain after previews disappear from the public
index. The branch contains no binaries, credentials or private signing keys.

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
then its matching stable release. Exact numbered previews remain exact until a
published replacement says otherwise.

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
`UAPKG_RELEASE_PUBLIC_KEY` is embedded in release launchers. The private
`UAPKG_RELEASE_SECRET_KEY` is available only to the native publication job.

Infrastructure uses a **distinct** private key for generated indexes and replacement
documents. `UAPKG_CATALOG_PUBLIC_KEY` is embedded in launchers. A metadata key cannot
authorize an archive, and an artifact key cannot authorize an alias or replacement.
All signatures include Minisign's trusted-comment signature; changing whitespace or
JSON formatting changes signed bytes. Clients authenticate a document before using
its contents and authenticate checksums before trusting downloaded archives.

Never rotate either production key by changing an unsigned endpoint. With the current
single-key trust anchors, coordinate a launcher bootstrap carrying the replacement
public key before switching that signer; old launchers require manual replacement.
Preserve historical artifacts, checksums and their original signatures. An automated
overlapping-key rotation would require its own explicit protocol and implementation.

## Publishing and cutover

1. Version the intended product on `main`. CLI/library versions continue to use
   Changesets. Launcher versioning is owned by `launcher/Cargo.toml`.
2. Run the `Release` workflow manually with the exact product/version. It never
   creates a version PR. npm packages publish independently when the product is
   `cli`; native publication has no npm-existence or npm-success gate.
3. For a CLI release, supply an already published launcher version for all-seven-platform
   terminal qualification. Publish launcher `0.3.0` before the next CLI minor release
   (`1.7.0`) for the Windows naming and musl transition.
   General CI can qualify CLI runtime candidates before the paired launcher exists.
4. The workflow publishes immutable assets and checksums, verifies the remote bytes,
   and commits `catalog-release`. A complete existing release skips native rebuilding
   on retry. A partially uploaded release requires the original retained artifacts;
   differing rebuilt bytes are rejected rather than overwritten.
5. The repository push webhook informs infrastructure. A missed webhook is recovered
   by manually running the infrastructure site workflow. There is no source recovery
   scan, catalog polling/reconciliation timer or GitHub Actions schedule.

The CLI workflow never rebuilds a launcher. The launcher workflow does not build a
CLI or require npm publication. Node/Vite+ are still repository packaging tools.
Combined archives are removed. The independent terminal harness assembles temporary
test installations from a verified launcher and the CLI candidate; these are not
published bundles.

Old launchers discover only CLI-tagged `release.json` assets. They cannot discover
this new protocol unaided. Install the new launcher manually without deleting the
user profile; the installer experience is tracked separately. Historical tags and
release assets stay unchanged, and this cutover uses minor versions.

For the seven-platform transition, first deploy the infrastructure reader that
recognizes both platform matrices, then publish launcher `0.3.0`, then qualify and
publish CLI `1.7.0` with that launcher. The updated launcher binaries must exist
before expanded signed indexes activate. Launchers through `0.2.0` reject new
identifiers anywhere in a product index, so all operating systems require manual
launcher replacement at this cutover. Windows users must select a CLI release
containing `win-*` artifacts; historical Windows pins report the target unavailable.
Old `win32-*` caches are left intact and are not relabeled or reused. See
[platform support and transition](platform-support.md).
