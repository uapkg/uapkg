# uapkg-launcher

## 0.3.6

### Patch Changes

- [`00f7ccc`](https://github.com/uapkg/uapkg/commit/00f7cccb2090c6addc43a78e4a8234333c902eef) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Delay automatic launcher and CLI upgrades by a configurable minimum release age, defaulting to three days. Preserve explicit version selection and initial installation, support full publication timestamps with historical UTC dates, and share the compact duration format through configuration schemas.

## 0.3.5

### Patch Changes

- [`3d12fe7`](https://github.com/uapkg/uapkg/commit/3d12fe7ae0e7149d46698f0644983250cd64c706) - Accept additional fields in launcher JSON records and preserve them when updating existing state, while retaining required-field validation and signature, hash, and path checks.

## 0.3.4

### Patch Changes

- [`206e42d`](https://github.com/uapkg/uapkg/commit/206e42db9e11153007e0db79d189ccc6a5048115) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Respect signed release yanks and quarantines, redirect affected CLI selections to healthy previous releases, purge quarantined engines, and recover affected standalone launchers before running commands.
