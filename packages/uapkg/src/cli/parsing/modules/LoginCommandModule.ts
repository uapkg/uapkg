import type { Argv } from 'yargs';
import { createUAPKGCommandLineFactory } from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

export class LoginCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink): Argv {
    return parser.command(
      'login',
      'Sign in to one registry using your browser',
      (builder) =>
        builder
          .option('registry', {
            type: 'string',
            requiresArg: true,
            describe: 'Registry alias, uses "default" when omitted',
          })
          .option('device-name', {
            type: 'string',
            describe: 'Device label shown on the authorization page',
          })
          .option('reauthorize', {
            type: 'boolean',
            default: false,
            describe: 'Replace the saved login for this registry',
          })
          .option('json', {
            type: 'boolean',
            default: false,
            describe: 'Emit JSON on stdout',
          }),
      (argv) => {
        sink.set(
          this.factory.createLogin({
            cwd: process.cwd(),
            registry: typeof argv.registry === 'string' ? argv.registry : undefined,
            deviceName: typeof argv['device-name'] === 'string' ? argv['device-name'] : undefined,
            reauthorize: argv.reauthorize === true,
            outputFormat: argv.json ? 'json' : 'text',
          }),
        );
      },
    );
  }
}
