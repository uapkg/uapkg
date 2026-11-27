import type { Argv } from 'yargs';
import {
  createUAPKGCommandLineFactory,
  type UAPKGControlPlaneAuthMode,
  type UAPKGLifecycleCommandName,
} from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

const AUTH_MODES = ['auto', 'login', 'gat', 'oidc'] as const;

const OPERATIONS: ReadonlyArray<{ readonly name: UAPKGLifecycleCommandName; readonly describe: string }> = [
  { name: 'yank', describe: 'Exclude a published version from new resolution' },
  { name: 'unyank', describe: 'Restore a yanked version to new resolution' },
  { name: 'unpublish', describe: 'Permanently remove a recently published version' },
  { name: 'deprecate', describe: 'Attach a deprecation warning to a version' },
  { name: 'undeprecate', describe: 'Clear the deprecation warning from a version' },
];

/**
 * Registers the five route-derived package lifecycle commands. Each command
 * shares one shape: `uapkg <operation> <package> <version> [--reason ...]`.
 */
export class LifecycleCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink): Argv {
    let current = parser;
    for (const operation of OPERATIONS) {
      current = current.command(
        `${operation.name} <package> <version>`,
        operation.describe,
        (builder) =>
          builder
            .positional('package', { type: 'string', describe: 'Package name' })
            .positional('version', { type: 'string', describe: 'Exact package version' })
            .option('reason', { type: 'string', describe: 'Reason recorded with the request' })
            .option('registry', {
              type: 'string',
              requiresArg: true,
              describe: 'Registry alias, uses "default" when omitted',
            })
            .option('auth', {
              type: 'string',
              choices: AUTH_MODES,
              default: 'auto',
              describe: 'Authentication method',
            })
            .option('detach', {
              type: 'boolean',
              default: false,
              describe: 'Return immediately after submitting the request',
            })
            .option('json', {
              type: 'boolean',
              default: false,
              describe: 'Emit JSON on stdout',
            }),
        (argv) => {
          sink.set(
            this.factory.createLifecycle(operation.name, String(argv.package ?? ''), String(argv.version ?? ''), {
              cwd: process.cwd(),
              reason: stringOption(argv.reason),
              registry: stringOption(argv.registry),
              auth: String(argv.auth) as UAPKGControlPlaneAuthMode,
              detach: argv.detach === true,
              outputFormat: argv.json ? 'json' : 'text',
            }),
          );
        },
      );
    }
    return current;
  }
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
