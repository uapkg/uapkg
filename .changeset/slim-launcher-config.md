---
'@uapkg/cli': patch
---

Resolve launcher settings through normal global, intermediary, and local config
layers using a read-only native resolver and a schema generated from
`@uapkg/config`. Ignore invalid launcher overrides with source-aware warnings,
preserve valid fallback values, and expose accepted and ignored config traces.
