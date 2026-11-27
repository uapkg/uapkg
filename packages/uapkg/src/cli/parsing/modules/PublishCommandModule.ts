import type { Argv } from 'yargs';
import { createUAPKGCommandLineFactory, type UAPKGControlPlaneAuthMode } from '#cli/cli/UAPKGCommandLine.ts';
import type { CommandLineSink, UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';

const AUTH_MODES = ['auto', 'login', 'gat', 'oidc'] as const;

export class PublishCommandModule implements UAPKGCommandModule {
  private readonly factory = createUAPKGCommandLineFactory();

  register(parser: Argv, sink: CommandLineSink): Argv {
    return parser.command(
      'publish',
      'Submit a GitHub Release asset for publication',
      (builder) =>
        builder
          .option('registry', {
            type: 'string',
            requiresArg: true,
            describe: 'Registry alias, uses "default" when omitted',
          })
          .option('owner', {
            type: 'string',
            describe: 'UAPKG organization name for a new unscoped package',
          })
          .option('repository', { type: 'string', describe: 'GitHub repository in owner/repository form' })
          .option('tag', { type: 'string', describe: 'GitHub Release tag (defaults to v<version>)' })
          .option('asset', { type: 'string', describe: 'GitHub Release asset name (defaults to package.tgz)' })
          .option('asset-path', {
            type: 'string',
            describe: 'Local archive whose exact bytes should be published (skips the download)',
          })
          .option('auth', {
            type: 'string',
            choices: AUTH_MODES,
            default: 'auto',
            describe: 'Publishing authentication method',
          })
          .option('detach', {
            type: 'boolean',
            default: false,
            describe: 'Return immediately after submitting the publishing request',
          })
          .option('json', {
            type: 'boolean',
            default: false,
            describe: 'Emit JSON on stdout',
          }),
      (argv) => {
        sink.set(
          this.factory.createPublish({
            cwd: process.cwd(),
            registry: stringOption(argv.registry),
            owner: stringOption(argv.owner),
            repository: stringOption(argv.repository),
            tag: stringOption(argv.tag),
            asset: stringOption(argv.asset),
            assetPath: stringOption(argv['asset-path']),
            auth: String(argv.auth) as UAPKGControlPlaneAuthMode,
            detach: argv.detach === true,
            outputFormat: argv.json ? 'json' : 'text',
          }),
        );
      },
    );
  }
}

function stringOption(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}
