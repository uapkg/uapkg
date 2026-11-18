---
'uapkg-launcher': patch
'@uapkg/config': patch
'@uapkg/common-schema': patch
---

Delay automatic launcher and CLI upgrades by a configurable minimum release age, defaulting to three days. Preserve explicit version selection and initial installation, support full publication timestamps with historical UTC dates, and share the compact duration format through configuration schemas.
