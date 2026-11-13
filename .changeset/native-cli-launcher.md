---
'@uapkg/cli': minor
'@uapkg/config': minor
'@uapkg/package-manifest-schema': minor
---

Move the `uapkg` command to a native Rust launcher with exact game-project CLI
pins, isolated version caches, GitHub and npm engine sources, and explicit
installation-aware launcher updates. The npm CLI package no longer registers a
command. New game project manifests record their CLI version automatically.

Add `uapkg --debug-info` for copyable system and version-selection diagnostics.
