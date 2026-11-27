# @uapkg/integration

Use `defineIntegration` to declare host-project setup from a UAPKG plugin. Save the definition
in `.uapkg/integration.ts`, or select another entry through `integration.entry` in
`uapkg.json`.

```ts
import { defineIntegration } from '@uapkg/integration';

export default defineIntegration({
  setupProject: { plugins: ['EditorScriptingUtilities'] },
});
```

The **workspace** is the Unreal game project or plugin directory where you run `uapkg add`
or `uapkg install`. It contains the active `uapkg.json`. When authoring a plugin, UAPKG
records its direct runtime plugin dependencies in its root `.uplugin`. When installing
into a game, the game's `.uproject` and its `Source` directory are the targets for approved
host integrations, including those declared by transitive dependencies.

Use `setupModules` and `setupTargets` to select the game's modules and targets by name or
with `all`. `classBody` inserts member declarations in the selected rules class, and
`constructorBody` inserts statements in its constructor. Statements from the same package
share a local scope. Two packages can each declare a local with the same name.
The statements still run inside the game's constructor, so a `return;` exits that
constructor and skips subsequent statements.

The editor parses C# and follows rules base classes declared under the game's `Source`
directory. A target such as Lyra's EOS variant can inherit its game's target. Constructor
edits require one active, public, block-bodied rules constructor. If its location depends
on unknown build symbols, UAPKG reports the file and leaves the proposed edits unapplied.
For `includes`, UAPKG places contributed global and ordinary using directives in C# order.
