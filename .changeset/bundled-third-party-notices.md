---
'@uapkg/cli': patch
'uapkg-launcher': patch
---

Include a CycloneDX dependency inventory in CLI tarballs.
Print the launcher's embedded Cargo dependency inventory with `uapkg launcher --license`, including when offline.
