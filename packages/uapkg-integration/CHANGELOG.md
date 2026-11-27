# @uapkg/integration

## 1.7.6

### Patch Changes

- [`2139934`](https://github.com/uapkg/uapkg/commit/21399340ab8e8088bcabaf3429a76dd5d90f405e) Thanks [@MaximDevoir](https://github.com/MaximDevoir)! - Add exact-release permissions for plugin lifecycle scripts and Unreal host integration. Install direct native plugin references, run approved hooks from verified package bytes, and reconcile owned workspace edits across installs and removals. Package authors can generate files during prepack and pin a Node runtime. Pass offline mode through the launcher for lifecycle runtime selection.

  Commands that accept `--registry` use the `default` alias when the option is omitted. If the default registry contains the package and `uapkg.json` names another registry for it, the CLI lists the aliases to choose from.

  Managed Node runtimes refresh release keys from the official Node.js key repository and cache them for offline signature verification. A CLI with this updater can recognize newly authorized signers and revocations without a new UAPKG release.

  Parse Unreal C# rules when applying host integrations. Resolve inherited project targets, honor conditional compilation and using directive order, and give each package's constructor statements a separate local scope.
