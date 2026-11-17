#!/bin/sh
set -eu
cd /work
version="$(cat .node-version)"
runtime="node-v${version}-linux-x64-musl"
archive="dist/official-node/linux-x64-musl/${runtime}.tar.xz"
# The separate provisioning job verified the upstream signature. Detect changes
# to its authenticated archive before extracting or executing any bundled file.
expected="$(sed -n 's/.*"sha256": "\([a-f0-9]*\)".*/\1/p' dist/official-node/linux-x64-musl/node-provenance.json)"
test "${#expected}" -eq 64
printf '%s  %s\n' "$expected" "$archive" | sha256sum -c -
mkdir -p /opt/uapkg-node
tar -xf "$archive" -C /opt/uapkg-node
export PATH="/opt/uapkg-node/${runtime}/bin:$PATH"
export UAPKG_NODE_PROVENANCE=/work/dist/official-node/linux-x64-musl/node-provenance.json
node tools/release/runRelease.ts build-native --format "$1" --output "dist/native/$1"
if [ -n "${SMOKE_LAUNCHER_VERSION:-}" ] && [ "$1" = node ]; then
  node tools/release/fetchSmokeLauncher.ts "$SMOKE_LAUNCHER_VERSION" dist/smoke-launcher
fi
