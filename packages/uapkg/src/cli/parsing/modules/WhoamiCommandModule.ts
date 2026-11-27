import type { Argv } from 'yargs';
import {
  createUAPKGCommandLineFactory,
  UAPKG_WHOAMI_FIELDS,
  type UAPKGWhoamiField,
} from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

export class WhoamiCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink): Argv {
    return parser.command(
      'whoami [field]',
      'Show the account associated with this registry login',
      (builder) =>
        builder
          .positional('field', {
            type: 'string',
            choices: UAPKG_WHOAMI_FIELDS,
            describe: 'Identity or registry field to print',
          })
          .option('registry', {
            type: 'string',
            requiresArg: true,
            describe: 'Registry alias, uses "default" when omitted',
          })
          .option('json', {
            type: 'boolean',
            default: false,
            describe: 'Emit JSON on stdout',
          }),
      (argv) => {
        sink.set(
          this.factory.createWhoami({
            cwd: process.cwd(),
            field: typeof argv.field === 'string' ? (argv.field as UAPKGWhoamiField) : undefined,
            registry: typeof argv.registry === 'string' ? argv.registry : undefined,
            outputFormat: argv.json ? 'json' : 'text',
          }),
        );
      },
    );
  }
}
