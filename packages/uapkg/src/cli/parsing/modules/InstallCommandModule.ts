import type { Argv } from 'yargs';
import { createUAPKGCommandLineFactory } from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

export class InstallCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink) {
    return parser.command(
      'install',
      'Install dependencies from uapkg.json',
      (builder) =>
        builder
          .option('force', {
            type: 'boolean',
            default: false,
            describe: 'Override safety policies (e.g. target dir exists without uapkg.json)',
          })
          .option('frozen', {
            type: 'boolean',
            default: false,
            describe: 'Install from the existing uapkg.lock without resolving new versions',
          })
          .option('dry-run', {
            type: 'boolean',
            default: false,
            describe: 'Preview installation; the lockfile and registry cache may still change',
          })
          .option('json', { type: 'boolean', default: false, describe: 'Emit JSON on stdout' })
          .option('ignore-release-age', {
            type: 'boolean',
            default: false,
            describe: 'Resolve packages without the minimum release age policy',
          })
          .check((argv) => {
            if (argv.force && argv.frozen) throw new Error('--force and --frozen are mutually exclusive');
            return true;
          }),
      (argv) => {
        sink.set(
          this.factory.createInstall({
            cwd: process.cwd(),
            force: argv.force,
            frozen: argv.frozen,
            dryRun: argv['dry-run'],
            ignoreReleaseAge: argv['ignore-release-age'],
            outputFormat: argv.json ? 'json' : 'text',
          }),
        );
      },
    );
  }
}
