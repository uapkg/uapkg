---
'@uapkg/cli': patch
'@uapkg/common': patch
'@uapkg/config': patch
'@uapkg/diagnostics': patch
'@uapkg/installer': patch
'@uapkg/package-manifest': patch
'@uapkg/registry-core': patch
'@uapkg/registry-schema': patch
'@uapkg/registry-tools': patch
---

Apply a configurable minimum release age to implicit plugin resolution and updates. The default is three days. Preserve compatible lockfile entries, support recursive targeted updates, and report releases held back by the cooldown. Registry package versions now require a publication timestamp in Unix seconds.

Finish CLI progress reporting when an installation completes or fails, and stage extracted plugins on the project volume so installs work across Windows drives.
