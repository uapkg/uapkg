---
'@uapkg/cli': patch
'@uapkg/diagnostics': patch
'@uapkg/diagnostics-format': patch
'@uapkg/installer': patch
'@uapkg/registry-core': patch
---

Show the configured registry name when a package lookup fails or registry metadata is invalid. When an update targets a package missing from `uapkg.json`, identify the missing project dependency.
