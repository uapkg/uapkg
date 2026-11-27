import type { Argv } from 'yargs';
import { createUAPKGCommandLineFactory } from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

export class UpdateCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink) {
    return parser.command(
      'update [specs..]',
      'Update dependencies and the lockfile',
      (builder) =>
        builder
          .positional('specs', { type: 'string', array: true, describe: 'Package names with optional version ranges' })
          .option('ignore-scripts', {
            type: 'boolean',
            default: false,
            describe: 'Skip executable lifecycle hooks and integrations',
          })
          .option('force', {
            type: 'boolean',
            default: false,
            describe: 'Override safety policies for local drift/branch divergence',
          })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            describe: 'Preview installation; the manifest, lockfile, and registry cache may still change',
          })
          .option('json', { type: 'boolean', default: false, describe: 'Emit JSON on stdout' })
          .option('recursive', {
            type: 'boolean',
            default: false,
            describe: 'Also update the direct and indirect dependencies of the selected packages',
          })
          .option('ignore-release-age', {
            type: 'boolean',
            default: false,
            describe: 'Resolve packages without the minimum release age policy',
          }),
      (argv) => {
        const specsArg = argv.specs;
        const specs = Array.isArray(specsArg) ? (specsArg.filter((v) => typeof v === 'string') as string[]) : [];
        sink.set(
          this.factory.createUpdate({
            cwd: process.cwd(),
            ignoreScripts: argv['ignore-scripts'],
            specs,
            force: argv.force,
            dryRun: argv['dry-run'],
            recursive: argv.recursive,
            ignoreReleaseAge: argv['ignore-release-age'],
            outputFormat: argv.json ? 'json' : 'text',
          }),
        );
      },
    );
  }
}
