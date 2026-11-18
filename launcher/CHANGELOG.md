# uapkg-launcher

## 0.3.5

### Patch Changes

- [`3d12fe7`](https://github.com/uapkg/uapkg/commit/3d12fe7ae0e7149d46698f0644983250cd64c706) - Accept additional fields in launcher JSON records and preserve them when updating existing state, while retaining required-field validation and signature, hash, and path checks.

## 0.3.4

### Patch Changes

- [`206e42d`](https://github.com/uapkg/uapkg/commit/206e42db9e11153007e0db79d189ccc6a5048115) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Respect signed release yanks and quarantines, redirect affected CLI selections to healthy previous releases, purge quarantined engines, and recover affected standalone launchers before running commands.
