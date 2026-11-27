import type { Argv } from 'yargs';
import { createUAPKGCommandLineFactory, type UAPKGRegistryRequestStatus } from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

const REQUEST_STATUSES = [
  'queued',
  'checking',
  'accepted',
  'ready',
  'ready_superseded',
  'rejected',
  'operationally_failed',
] as const;

export class RequestsCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink): Argv {
    return parser.command(
      'requests',
      'List or inspect your publishing requests',
      (builder) =>
        builder
          .command(
            'list',
            'List your publishing requests',
            (listBuilder) =>
              listBuilder
                .option('registry', {
                  type: 'string',
                  requiresArg: true,
                  describe: 'Registry alias, uses "default" when omitted',
                })
                .option('status', {
                  type: 'string',
                  choices: REQUEST_STATUSES,
                  describe: 'Filter requests by status',
                })
                .option('json', {
                  type: 'boolean',
                  default: false,
                  describe: 'Emit JSON on stdout',
                })
                .strict(),
            (argv) => {
              sink.set(
                this.factory.createRequests('list', {
                  cwd: process.cwd(),
                  registry: typeof argv.registry === 'string' ? argv.registry : undefined,
                  status: typeof argv.status === 'string' ? (argv.status as UAPKGRegistryRequestStatus) : undefined,
                  outputFormat: argv.json ? 'json' : 'text',
                }),
              );
            },
          )
          .command(
            'status <request-id>',
            'Inspect one publishing request',
            (statusBuilder) =>
              statusBuilder
                .positional('request-id', {
                  type: 'string',
                  demandOption: true,
                  describe: 'Publishing request identifier',
                })
                .option('watch', {
                  type: 'boolean',
                  default: false,
                  describe: 'Watch until the request is ready, rejected, or fails',
                })
                .option('json', {
                  type: 'boolean',
                  default: false,
                  describe: 'Emit JSON on stdout',
                })
                .strict(),
            (argv) => {
              sink.set(
                this.factory.createRequests('status', {
                  cwd: process.cwd(),
                  requestId: typeof argv['request-id'] === 'string' ? argv['request-id'] : undefined,
                  watch: argv.watch === true,
                  outputFormat: argv.json ? 'json' : 'text',
                }),
              );
            },
          )
          .demandCommand(1)
          .strict(),
      () => undefined,
    );
  }
}
