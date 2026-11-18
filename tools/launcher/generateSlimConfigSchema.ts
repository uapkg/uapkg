import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { updateSlimConfigSchema } from './SlimConfigSchemaArtifact.ts';

const args = process.argv.slice(2).filter((arg) => arg !== '--');
if (args.some((arg) => arg !== '--check')) throw new Error('Usage: generateSlimConfigSchema.ts [--check]');
// The root tooling package does not depend on @uapkg/config. Resolve its public
// export from the CLI package, which owns that workspace dependency.
const requireFromCli = createRequire(new URL('../../packages/uapkg/package.json', import.meta.url));
const { createSlimConfigSchema } = (await import(
  pathToFileURL(requireFromCli.resolve('@uapkg/config/slim-schema')).href
)) as typeof import('@uapkg/config/slim-schema');
const file = fileURLToPath(
  new URL('../../launcher/crates/slim-config/generated/slim-config.schema.json', import.meta.url),
);
updateSlimConfigSchema(file, createSlimConfigSchema(), args.includes('--check'));
