import type { Argv } from 'yargs';
import { createUAPKGCommandLineFactory } from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

export class AddCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink) {
    return parser.command(
      'add <source>',
      'Add a dependency to uapkg.json and install it',
      (builder) =>
        builder
          .positional('source', {
            type: 'string',
            describe: 'Package name with an optional version range',
            demandOption: true,
          })
          .option('force', {
            type: 'boolean',
            default: false,
            describe: 'Override safety policy for local drift/branch divergence',
          })
          .option('pin', {
            type: 'boolean',
            default: false,
            describe: 'Add or replace the project override for this dependency',
          })
          .option('dev', { type: 'boolean', default: false, describe: 'Add to devDependencies' })
          .option('registry', { type: 'string', describe: 'Registry name (defaults to config `registry`)' })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            describe: 'Preview installation; the manifest, lockfile, and registry cache may still change',
          })
          .option('json', { type: 'boolean', default: false, describe: 'Emit JSON on stdout' })
          .option('ignore-release-age', {
            type: 'boolean',
            default: false,
            describe: 'Resolve packages without the minimum release age policy',
          }),
      (argv) => {
        sink.set(
          this.factory.createAdd(String(argv.source), {
            cwd: process.cwd(),
            force: argv.force,
            pin: argv.pin,
            dev: argv.dev,
            registry: typeof argv.registry === 'string' ? argv.registry : undefined,
            dryRun: argv['dry-run'],
            ignoreReleaseAge: argv['ignore-release-age'],
            outputFormat: argv.json ? 'json' : 'text',
          }),
        );
      },
    );
  }
}
