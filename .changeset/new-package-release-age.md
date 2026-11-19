---
'@uapkg/cli': patch
'@uapkg/config': patch
'@uapkg/diagnostics': patch
'@uapkg/package-manifest': patch
---

Apply the configured minimum release age when adding a new plugin and its dependencies. A bare `uapkg add` saves the highest eligible stable version that works with the project and reports any newer compatible release held back by age.

Set `packages.resolution.applyReleaseAgeToNewPackages` to `false` to opt out for newly added plugins and their exclusively new dependencies. Use `--ignore-release-age` to bypass the cooldown for a single command.
