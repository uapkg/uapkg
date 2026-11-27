import type { Argv } from 'yargs';
import type { Capability } from '@uapkg/package-manifest-schema';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

function releaseCommand(builder: Argv, sink: CommandLineSink, action: 'approve' | 'revoke' | 'retry') {
  return builder.command(
    `${action} <package>`,
    `${action} a capability for one installed release`,
    (b) => {
      const args = b
        .positional('package', { type: 'string', demandOption: true })
        .option('registry', {
          type: 'string',
          requiresArg: true,
          describe: 'Registry alias, uses "default" when omitted',
        })
        .option('capability', { choices: ['integration', 'postinstall'] as const, demandOption: true })
        .strict();
      return action === 'revoke'
        ? args
            .option('integrity', { type: 'string', describe: 'Digest of a saved release' })
            .option('registry-id', { type: 'string', describe: 'Source identity of a saved release' })
        : args;
    },
    (argv) => {
      const target = {
        cwd: process.cwd(),
        packageName: String(argv.package),
        registry: argv.registry,
        capability: argv.capability as Capability,
      };
      sink.set(
        action === 'retry'
          ? { command: 'lifecycle-retry', ...target }
          : {
              command: 'permissions',
              action,
              ...target,
              integrity: typeof argv.integrity === 'string' ? argv.integrity : undefined,
              registryId: typeof argv.registryId === 'string' ? argv.registryId : undefined,
            },
      );
    },
  );
}

export class PermissionsCommandModule implements UAPKGCommandModule {
  register(parser: Argv, sink: CommandLineSink): Argv {
    return parser
      .command(
        'permissions',
        'Manage workspace release permissions',
        (builder) =>
          releaseCommand(releaseCommand(builder, sink, 'approve'), sink, 'revoke')
            .command(
              'list',
              'List exact-release permissions',
              (b) => b.strict(),
              () => sink.set({ command: 'permissions', action: 'list', cwd: process.cwd() }),
            )
            .demandCommand(1)
            .strict(),
        () => undefined,
      )
      .command(
        'lifecycle',
        'Manage local lifecycle execution',
        (builder) => releaseCommand(builder, sink, 'retry').demandCommand(1).strict(),
        () => undefined,
      );
  }
}
