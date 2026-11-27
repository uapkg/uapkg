import type { Argv } from 'yargs';
import { createUAPKGCommandLineFactory } from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

export class RemoveCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink): Argv {
    return parser.command(
      'remove <package>',
      'Remove a dependency from uapkg.json and update installed packages',
      (builder) =>
        builder
          .positional('package', { type: 'string', demandOption: true, describe: 'Package name to remove' })
          .option('ignore-scripts', {
            type: 'boolean',
            default: false,
            describe: 'Skip executable lifecycle hooks and integrations',
          })
          .option('json', { type: 'boolean', default: false, describe: 'Emit JSON on stdout' })
          .option('ignore-release-age', {
            type: 'boolean',
            default: false,
            describe: 'Resolve packages without the minimum release age policy',
          }),
      (argv) => {
        sink.set(
          this.factory.createRemove(String(argv.package), {
            cwd: process.cwd(),
            ignoreScripts: argv['ignore-scripts'],
            ignoreReleaseAge: argv['ignore-release-age'],
            outputFormat: argv.json ? 'json' : 'text',
          }),
        );
      },
    );
  }
}
