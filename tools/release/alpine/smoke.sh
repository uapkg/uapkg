#!/bin/sh
set -eu
cd /work
# Containers share the host kernel; the pinned userspace alone cannot qualify
# Node's documented kernel floor.
kernel="$(uname -r | cut -d- -f1)"
test "$(printf '6.12\n%s\n' "$kernel" | sort -V | head -n 1)" = 6.12
# The test driver is the runtime packaged with the CLI, not a preinstalled Node.
test -z "$(command -v node || true)"
test -z "$(command -v npm || true)"
for forbidden in gcompat libc6-compat glibc; do
  ! apk info -e "$forbidden" >/dev/null 2>&1
done
format="$1"
engine="/work/dist/native/$format/cli"
driver=/work/dist/native/node/cli/runtime/node
export UAPKG_TERMINAL_SMOKE_BINARY=/work/dist/terminal-smoke/packaged
export UAPKG_SMOKE_LAUNCHER=/work/dist/smoke-launcher/uapkg
test -x "$UAPKG_TERMINAL_SMOKE_BINARY"
test -x "$UAPKG_SMOKE_LAUNCHER"
test "$("$UAPKG_SMOKE_LAUNCHER" launcher --platform)" = linux-x64-musl
"$driver" tools/release/BinaryAudit.ts "$engine" linux-x64-musl "dist/evidence/abi-$format-linux-x64-musl.json"
if [ "$format" = sea ]; then
  # SEA embeds these locked native addon bytes in its VFS; inspect the staging
  # bytes as well as proving that the embedded addon loads in both probes.
  for addon in /work/dist/native/sea/runtime-package/node_modules/@napi-rs/keyring-linux-x64-musl/*.node; do
    "$driver" tools/release/BinaryAudit.ts "$addon" linux-x64-musl dist/evidence/abi-sea-keyring-linux-x64-musl.json
  done
fi
"$driver" tools/release/BinaryAudit.ts "$UAPKG_SMOKE_LAUNCHER" linux-x64-musl dist/evidence/abi-launcher-linux-x64-musl.json
export DBUS_SESSION_BUS_ADDRESS=unix:path=/tmp/uapkg-no-secret-service
export UAPKG_RELEASE_SMOKE_HEADLESS=1
"$driver" tools/release/runRelease.ts smoke-native --engine "$engine"
unset UAPKG_RELEASE_SMOKE_HEADLESS DBUS_SESSION_BUS_ADDRESS
dbus-run-session -- sh -eu -c '
  printf "%s" "uapkg-ci-keyring" | gnome-keyring-daemon --unlock --components=secrets
  /work/dist/native/node/cli/runtime/node tools/release/runRelease.ts smoke-native --engine "/work/dist/native/$1/cli" --keyring
' sh "$format"
