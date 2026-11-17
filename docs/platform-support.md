# Standalone platform support

The launcher and CLI ship separately. A supported platform must run both the
Rust launcher and the CLI's bundled Node runtime and native dependencies.
Node, npm and Rust do not need to be installed on the user's machine.

| Distribution identifier | Environment                           |
| ----------------------- | ------------------------------------- |
| `win-x64`               | Windows on Intel/AMD x64              |
| `win-arm64`             | Windows on ARM64                      |
| `darwin-x64`            | macOS on Intel x64                    |
| `darwin-arm64`          | macOS on Apple Silicon                |
| `linux-x64`             | Linux x64 with glibc                  |
| `linux-arm64`           | Linux ARM64 with glibc                |
| `linux-x64-musl`        | Linux x64 with musl, including Alpine |

All seven targets are 64-bit. `win32` remains Node's operating-system identifier
on Windows, independent of architecture. UAPKG uses `win` in distribution names,
as Node does in its official archive names. Node APIs, npm OS constraints and
third-party package names still use their upstream `win32` identifiers.

ARM64 Alpine/musl, POWER, IBM Z, AIX and 32-bit targets are not supported.
ARM64 Linux with glibc remains supported.

## Runtime source and Linux requirements

Standalone builds use the exact Node version in `.node-version`, downloaded from
official Node releases and authenticated with the upstream signed checksums and a
pinned Node release-key keyring. A missing official binary blocks qualification.
UAPKG does not build Node from source, use unofficial binaries or substitute
another Node version. ARM64 musl can be reconsidered when supported official
binaries become available, or through an explicit support-policy decision.

glibc and musl are different C runtime implementations. A glibc executable does
not become an Alpine executable because it has the correct CPU architecture.
Choose `linux-x64-musl` on Alpine x64; do not install a glibc compatibility package
as a substitute for a supported distribution. Docker containers follow the libc
of their image and share the host's kernel.

The Alpine qualification image is Alpine 3.22.2 with musl 1.2.5. The pinned Node
26.13.1 upstream support floor is musl 1.2.5 and Linux kernel 6.12. Container tests
record the actual host kernel; they do not emulate that minimum kernel. The glibc
qualification baseline is Ubuntu 24.04 (glibc 2.39). Node's lower glibc floor is
not a compatibility claim for the complete launcher/CLI distribution.

Release qualification records ELF interpreters, shared libraries and required
symbol versions for the launcher, Node/SEA executable and native addons. It also
runs the packaged CLI in a clean runtime environment. Consult that release's ABI
evidence when evaluating a distribution outside the tested baseline.

Linux needs the runtime libraries identified by that evidence, including
`libstdc++`, `libgcc` and `libatomic`, plus CA certificates and Git for network and
Git operations. On Linux, the pinned native credential binding first tries a
Secret Service provider over D-Bus, such as GNOME Keyring, then falls back to the
protected Linux kernel keyring when available. Secure login can therefore work
headlessly without a desktop secret service. If neither backend is available,
login reports unavailable secure storage and does not save secrets in plaintext.
Commands that do not need credentials remain usable. See the
[pinned binding's Linux backend selection](https://github.com/Brooooooklyn/keyring-node/blob/e46be75c3ba8d5fde6b88a17c6153b87ffe4b946/src/linux_credential_builder.rs).

The container qualification commands grant Docker's `IPC_LOCK` capability to
GNOME Keyring so its daemon can lock secret memory. Normal CLI operations do not
require running a privileged container.
The Alpine negative test uses an unavailable D-Bus address and Docker's default
kernel-keyring restrictions to verify refusal when neither secure backend is
available. A missing D-Bus service alone does not establish that condition on a
normal Linux host.

## Windows names and musl release transition

The release cutover targets launcher **0.3.0** followed by CLI **1.7.0** (the next
minor release). Release qualification and publication must finish before these
versions are available to install. Older releases retain their original archives
and signatures, including the historical `win32-x64` and `win32-arm64` names.

1. Deploy the catalog reader that accepts historical six-target and current
   seven-target receipts.
2. Publish and verify launcher 0.3.0 before publishing expanded catalog metadata.
   The publisher uploads/verifies binaries before committing its catalog receipt.
3. Qualify and publish CLI 1.7.0 using that published launcher for all seven targets.
4. Replace older launchers manually from a verified archive. On Windows, select
   a CLI version that contains the new `win-*` artifacts after it is published.

Launchers through 0.2.0 reject unknown identifiers anywhere in a product index,
even on platforms whose own name did not change. Their self-update path cannot
be relied on after this transition. Download the appropriate new launcher and
verify its checksum signature and archive hash as described in the
[installation guide](launcher.md).

Leave historical cache directories and their `engine.json` and `.installed.json`
records intact. New Windows installations use `win-*` directories. Renaming an
old directory does not convert its descriptor or signature. Historical Windows
version pins report the target unavailable rather than aliasing `win32-*` to
`win-*`; choose a new CLI version explicitly. Historical releases without musl
artifacts likewise cannot be selected on musl. Keep existing configuration and
credentials; do not delete the whole UAPKG profile.

`uapkg launcher --platform` reports the running launcher's compiled distribution
identifier without accessing the profile or network. Release packaging compares
it with the requested Rust target so cross-compilation cannot label an artifact
using the build machine's platform.
