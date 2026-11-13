import { prepareNpmPackage } from './EnginePackage.ts';

try {
  const directory = await prepareNpmPackage();
  process.stdout.write(`[uapkg-build] Prepared npm engine in ${directory}\n`);
} catch (error) {
  process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
