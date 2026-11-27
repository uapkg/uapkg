# uapkg-launcher

## 0.3.7

### Patch Changes

- [`260a6c1`](https://github.com/uapkg/uapkg/commit/260a6c1b175d7ca9c8fe070fa7a651f2de23968f) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Include a CycloneDX dependency inventory in CLI tarballs.
  Print the launcher's embedded Cargo dependency inventory with `uapkg launcher --license`, including when offline.

- [`2139934`](https://github.com/uapkg/uapkg/commit/21399340ab8e8088bcabaf3429a76dd5d90f405e) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Add exact-release permissions for plugin lifecycle scripts and Unreal host integration. Install direct native plugin references, run approved hooks from verified package bytes, and reconcile owned workspace edits across installs and removals. Package authors can generate files during prepack and pin a Node runtime. Pass offline mode through the launcher for lifecycle runtime selection.

  Commands that accept `--registry` use the `default` alias when the option is omitted. If the default registry contains the package and `uapkg.json` names another registry for it, the CLI lists the aliases to choose from.

  Managed Node runtimes refresh release keys from the official Node.js key repository and cache them for offline signature verification. A CLI with this updater can recognize newly authorized signers and revocations without a new UAPKG release.

  Parse Unreal C# rules when applying host integrations. Resolve inherited project targets, honor conditional compilation and using directive order, and give each package's constructor statements a separate local scope.

## 0.3.6

### Patch Changes

- [`00f7ccc`](https://github.com/uapkg/uapkg/commit/00f7cccb2090c6addc43a78e4a8234333c902eef) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Delay automatic launcher and CLI upgrades by a configurable minimum release age, defaulting to three days. Preserve explicit version selection and initial installation, support full publication timestamps with historical UTC dates, and share the compact duration format through configuration schemas.

## 0.3.5

### Patch Changes

- [`3d12fe7`](https://github.com/uapkg/uapkg/commit/3d12fe7ae0e7149d46698f0644983250cd64c706) - Accept additional fields in launcher JSON records and preserve them when updating existing state, while retaining required-field validation and signature, hash, and path checks.

## 0.3.4

### Patch Changes

- [`206e42d`](https://github.com/uapkg/uapkg/commit/206e42db9e11153007e0db79d189ccc6a5048115) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Respect signed release yanks and quarantines, redirect affected CLI selections to healthy previous releases, purge quarantined engines, and recover affected standalone launchers before running commands.
