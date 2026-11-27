import type { Capability } from '@uapkg/package-manifest-schema';
export type UAPKGCommandName =
  | 'permissions'
  | 'lifecycle-retry'
  | 'init'
  | 'add'
  | 'install'
  | 'update'
  | 'project-get-name'
  | 'config'
  | 'registry'
  | 'pack'
  | 'outdated'
  | 'why'
  | 'list'
  | 'remove'
  | 'login'
  | 'logout'
  | 'whoami'
  | 'publish'
  | 'yank'
  | 'unyank'
  | 'unpublish'
  | 'deprecate'
  | 'undeprecate'
  | 'requests';
export type UAPKGConfigAction = 'get' | 'list' | 'set' | 'delete' | 'edit';
export type UAPKGRegistryAction = 'add' | 'remove' | 'list' | 'use' | 'auth' | 'refresh';
export type UAPKGRequestsAction = 'list' | 'status';
export type UAPKGControlPlaneAuthMode = 'auto' | 'login' | 'gat' | 'oidc';
export const UAPKG_WHOAMI_FIELDS = ['username', 'user-id', 'registry', 'registry-id'] as const;
export type UAPKGWhoamiField = (typeof UAPKG_WHOAMI_FIELDS)[number];
export type UAPKGRegistryRequestStatus =
  | 'queued'
  | 'checking'
  | 'accepted'
  | 'ready'
  | 'ready_superseded'
  | 'rejected'
  | 'operationally_failed';
export type UAPKGConfigScope = 'global' | 'local';
export type UAPKGOutputFormat = 'text' | 'json';

interface BaseCommandLine {
  command: UAPKGCommandName;
  cwd: string;
}

export interface InitCommandLine extends BaseCommandLine {
  command: 'init';
  type?: 'project' | 'plugin';
  name?: string;
}

export interface AddCommandLine extends BaseCommandLine {
  ignoreScripts?: boolean;
  command: 'add';
  source: string;
  force: boolean;
  pin: boolean;
  dev: boolean;
  registry?: string;
  dryRun: boolean;
  ignoreReleaseAge: boolean;
  outputFormat: UAPKGOutputFormat;
}

export interface InstallCommandLine extends BaseCommandLine {
  ignoreScripts?: boolean;
  command: 'install';
  force: boolean;
  frozen: boolean;
  dryRun: boolean;
  ignoreReleaseAge: boolean;
  outputFormat: UAPKGOutputFormat;
}

export interface UpdateCommandLine extends BaseCommandLine {
  ignoreScripts?: boolean;
  command: 'update';
  specs: string[];
  force: boolean;
  dryRun: boolean;
  recursive: boolean;
  ignoreReleaseAge: boolean;
  outputFormat: UAPKGOutputFormat;
}

export interface ProjectGetNameCommandLine extends BaseCommandLine {
  command: 'project-get-name';
}

export interface ConfigCommandLine extends BaseCommandLine {
  command: 'config';
  action: UAPKGConfigAction;
  path?: string;
  value?: string;
  scope?: UAPKGConfigScope;
  output: UAPKGOutputFormat;
  showOrigin: boolean;
  trace: boolean;
}

export interface RegistryCommandLine extends BaseCommandLine {
  command: 'registry';
  action: UAPKGRegistryAction;
  name?: string;
  url?: string;
  refType?: 'branch' | 'tag' | 'rev';
  refValue?: string;
  scope?: UAPKGConfigScope;
  output: UAPKGOutputFormat;
}

export interface PackCommandLine extends BaseCommandLine {
  ignoreScripts?: boolean;
  command: 'pack';
  dryRun: boolean;
  allowMissingLfs: boolean;
  outFile?: string;
}

export interface OutdatedCommandLine extends BaseCommandLine {
  command: 'outdated';
  outputFormat: UAPKGOutputFormat;
}

export interface WhyCommandLine extends BaseCommandLine {
  command: 'why';
  target: string;
  outputFormat: UAPKGOutputFormat;
}

export interface ListCommandLine extends BaseCommandLine {
  command: 'list';
  depth: number;
  outputFormat: UAPKGOutputFormat;
}

export interface RemoveCommandLine extends BaseCommandLine {
  ignoreScripts?: boolean;
  command: 'remove';
  packageName: string;
  ignoreReleaseAge: boolean;
  outputFormat: UAPKGOutputFormat;
}

export interface LoginCommandLine extends BaseCommandLine {
  command: 'login';
  registry?: string;
  deviceName?: string;
  reauthorize: boolean;
  outputFormat: UAPKGOutputFormat;
}

export interface LogoutCommandLine extends BaseCommandLine {
  command: 'logout';
  registry?: string;
  localOnly: boolean;
  outputFormat: UAPKGOutputFormat;
}

export interface WhoamiCommandLine extends BaseCommandLine {
  command: 'whoami';
  field?: UAPKGWhoamiField;
  registry?: string;
  outputFormat: UAPKGOutputFormat;
}

export interface PublishCommandLine extends BaseCommandLine {
  command: 'publish';
  registry?: string;
  owner?: string;
  repository?: string;
  tag?: string;
  asset?: string;
  assetPath?: string;
  auth: UAPKGControlPlaneAuthMode;
  detach: boolean;
  outputFormat: UAPKGOutputFormat;
}

export type UAPKGLifecycleCommandName = 'yank' | 'unyank' | 'unpublish' | 'deprecate' | 'undeprecate';

export interface LifecycleCommandLine extends BaseCommandLine {
  command: UAPKGLifecycleCommandName;
  packageName: string;
  packageVersion: string;
  reason?: string;
  registry?: string;
  auth: UAPKGControlPlaneAuthMode;
  detach: boolean;
  outputFormat: UAPKGOutputFormat;
}

export interface RequestsCommandLine extends BaseCommandLine {
  command: 'requests';
  action: UAPKGRequestsAction;
  requestId?: string;
  registry?: string;
  status?: UAPKGRegistryRequestStatus;
  watch: boolean;
  outputFormat: UAPKGOutputFormat;
}

export type UAPKGCommandLine =
  | PermissionCommandLine
  | InitCommandLine
  | AddCommandLine
  | InstallCommandLine
  | UpdateCommandLine
  | ProjectGetNameCommandLine
  | ConfigCommandLine
  | RegistryCommandLine
  | PackCommandLine
  | OutdatedCommandLine
  | WhyCommandLine
  | ListCommandLine
  | RemoveCommandLine
  | LoginCommandLine
  | LogoutCommandLine
  | WhoamiCommandLine
  | PublishCommandLine
  | LifecycleCommandLine
  | RequestsCommandLine;

export type PermissionCommandLine =
  | { command: 'permissions'; action: 'list'; cwd: string }
  | {
      command: 'permissions';
      action: 'approve' | 'revoke';
      integrity?: string;
      registryId?: string;
      packageName: string;
      registry?: string;
      capability: Capability;
      cwd: string;
    }
  | { command: 'lifecycle-retry'; packageName: string; registry?: string; capability: Capability; cwd: string };

export interface CommonCommandLineOptions {
  cwd?: string;
}

export interface AddCommandLineOptions extends CommonCommandLineOptions {
  ignoreScripts?: boolean;
  force?: boolean;
  pin?: boolean;
  dev?: boolean;
  registry?: string;
  dryRun?: boolean;
  ignoreReleaseAge?: boolean;
  outputFormat?: UAPKGOutputFormat;
}

export interface InstallOrUpdateCommandLineOptions extends CommonCommandLineOptions {
  ignoreScripts?: boolean;
  force?: boolean;
  frozen?: boolean;
  dryRun?: boolean;
  ignoreReleaseAge?: boolean;
  outputFormat?: UAPKGOutputFormat;
}

export interface UpdateFactoryOptions extends InstallOrUpdateCommandLineOptions {
  specs?: string[];
  recursive?: boolean;
}

export interface OutdatedFactoryOptions extends CommonCommandLineOptions {
  outputFormat?: UAPKGOutputFormat;
}

export interface WhyFactoryOptions extends CommonCommandLineOptions {
  outputFormat?: UAPKGOutputFormat;
}

export interface ListFactoryOptions extends CommonCommandLineOptions {
  depth?: number;
  outputFormat?: UAPKGOutputFormat;
}

export interface RemoveFactoryOptions extends CommonCommandLineOptions {
  ignoreScripts?: boolean;
  ignoreReleaseAge?: boolean;
  outputFormat?: UAPKGOutputFormat;
}

export interface RegistryAuthCommandLineOptions extends CommonCommandLineOptions {
  registry?: string;
  outputFormat?: UAPKGOutputFormat;
}

export interface LoginCommandLineOptions extends RegistryAuthCommandLineOptions {
  deviceName?: string;
  reauthorize?: boolean;
}

export interface LogoutCommandLineOptions extends RegistryAuthCommandLineOptions {
  localOnly?: boolean;
}

export interface WhoamiCommandLineOptions extends RegistryAuthCommandLineOptions {
  field?: UAPKGWhoamiField;
}

export interface PublishCommandLineOptions extends RegistryAuthCommandLineOptions {
  owner?: string;
  repository?: string;
  tag?: string;
  asset?: string;
  assetPath?: string;
  auth?: UAPKGControlPlaneAuthMode;
  detach?: boolean;
}

export interface LifecycleCommandLineOptions extends RegistryAuthCommandLineOptions {
  reason?: string;
  auth?: UAPKGControlPlaneAuthMode;
  detach?: boolean;
}

export interface RequestsCommandLineOptions extends RegistryAuthCommandLineOptions {
  requestId?: string;
  status?: UAPKGRegistryRequestStatus;
  watch?: boolean;
}

export interface ConfigCommonOptions extends CommonCommandLineOptions {
  scope?: UAPKGConfigScope;
  output?: UAPKGOutputFormat;
}

export interface RegistryCommandLineOptions extends ConfigCommonOptions {
  name?: string;
  url?: string;
  refType?: 'branch' | 'tag' | 'rev';
  refValue?: string;
}

export interface ConfigGetOptions extends ConfigCommonOptions {
  showOrigin?: boolean;
  trace?: boolean;
}

export interface PackCommandLineOptions extends CommonCommandLineOptions {
  ignoreScripts?: boolean;
  dryRun?: boolean;
  allowMissingLfs?: boolean;
  outFile?: string;
}

export class UAPKGCommandLineFactory {
  constructor(private readonly cwdProvider: () => string = () => process.cwd()) {}

  createInit(options: { type?: 'project' | 'plugin'; name?: string } & CommonCommandLineOptions = {}): InitCommandLine {
    return {
      command: 'init',
      cwd: this.resolveCwd(options.cwd),
      type: options.type,
      name: options.name,
    };
  }

  createAdd(source: string, options: AddCommandLineOptions = {}): AddCommandLine {
    return {
      command: 'add',
      ...(options.ignoreScripts ? { ignoreScripts: true } : {}),
      cwd: this.resolveCwd(options.cwd),
      source,
      force: options.force === true,
      pin: options.pin === true,
      dev: options.dev === true,
      registry: options.registry,
      dryRun: options.dryRun === true,
      ignoreReleaseAge: options.ignoreReleaseAge === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createInstall(options: InstallOrUpdateCommandLineOptions = {}): InstallCommandLine {
    return {
      command: 'install',
      ...(options.ignoreScripts ? { ignoreScripts: true } : {}),
      cwd: this.resolveCwd(options.cwd),
      force: options.force === true,
      frozen: options.frozen === true,
      dryRun: options.dryRun === true,
      ignoreReleaseAge: options.ignoreReleaseAge === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createUpdate(options: UpdateFactoryOptions = {}): UpdateCommandLine {
    return {
      command: 'update',
      ...(options.ignoreScripts ? { ignoreScripts: true } : {}),
      cwd: this.resolveCwd(options.cwd),
      specs: options.specs ?? [],
      force: options.force === true,
      dryRun: options.dryRun === true,
      recursive: options.recursive === true,
      ignoreReleaseAge: options.ignoreReleaseAge === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createOutdated(options: OutdatedFactoryOptions = {}): OutdatedCommandLine {
    return {
      command: 'outdated',
      cwd: this.resolveCwd(options.cwd),
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createWhy(target: string, options: WhyFactoryOptions = {}): WhyCommandLine {
    return {
      command: 'why',
      cwd: this.resolveCwd(options.cwd),
      target,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createList(options: ListFactoryOptions = {}): ListCommandLine {
    return {
      command: 'list',
      cwd: this.resolveCwd(options.cwd),
      depth: options.depth ?? 0,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createRemove(packageName: string, options: RemoveFactoryOptions = {}): RemoveCommandLine {
    return {
      command: 'remove',
      ...(options.ignoreScripts ? { ignoreScripts: true } : {}),
      cwd: this.resolveCwd(options.cwd),
      packageName,
      ignoreReleaseAge: options.ignoreReleaseAge === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createLogin(options: LoginCommandLineOptions = {}): LoginCommandLine {
    return {
      command: 'login',
      cwd: this.resolveCwd(options.cwd),
      registry: options.registry,
      deviceName: options.deviceName,
      reauthorize: options.reauthorize === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createLogout(options: LogoutCommandLineOptions = {}): LogoutCommandLine {
    return {
      command: 'logout',
      cwd: this.resolveCwd(options.cwd),
      registry: options.registry,
      localOnly: options.localOnly === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createWhoami(options: WhoamiCommandLineOptions = {}): WhoamiCommandLine {
    return {
      command: 'whoami',
      cwd: this.resolveCwd(options.cwd),
      field: options.field,
      registry: options.registry,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createPublish(options: PublishCommandLineOptions = {}): PublishCommandLine {
    return {
      command: 'publish',
      cwd: this.resolveCwd(options.cwd),
      registry: options.registry,
      owner: options.owner,
      repository: options.repository,
      tag: options.tag,
      asset: options.asset,
      assetPath: options.assetPath,
      auth: options.auth ?? 'auto',
      detach: options.detach === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createLifecycle(
    command: UAPKGLifecycleCommandName,
    packageName: string,
    packageVersion: string,
    options: LifecycleCommandLineOptions = {},
  ): LifecycleCommandLine {
    return {
      command,
      cwd: this.resolveCwd(options.cwd),
      packageName,
      packageVersion,
      reason: options.reason,
      registry: options.registry,
      auth: options.auth ?? 'auto',
      detach: options.detach === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createRequests(action: UAPKGRequestsAction, options: RequestsCommandLineOptions = {}): RequestsCommandLine {
    return {
      command: 'requests',
      action,
      cwd: this.resolveCwd(options.cwd),
      requestId: options.requestId,
      registry: options.registry,
      status: options.status,
      watch: options.watch === true,
      outputFormat: options.outputFormat ?? 'text',
    };
  }

  createProjectGetName(options: CommonCommandLineOptions = {}): ProjectGetNameCommandLine {
    return {
      command: 'project-get-name',
      cwd: this.resolveCwd(options.cwd),
    };
  }

  createConfigGet(path: string, options: ConfigGetOptions = {}): ConfigCommandLine {
    return {
      command: 'config',
      action: 'get',
      cwd: this.resolveCwd(options.cwd),
      path,
      scope: options.scope,
      output: options.output ?? 'text',
      showOrigin: options.showOrigin === true,
      trace: options.trace === true,
    };
  }

  createConfigList(options: ConfigCommonOptions = {}): ConfigCommandLine {
    return {
      command: 'config',
      action: 'list',
      cwd: this.resolveCwd(options.cwd),
      scope: options.scope,
      output: options.output ?? 'text',
      showOrigin: false,
      trace: false,
    };
  }

  createConfigSet(path: string, value: string, options: ConfigCommonOptions = {}): ConfigCommandLine {
    return {
      command: 'config',
      action: 'set',
      cwd: this.resolveCwd(options.cwd),
      path,
      value,
      scope: options.scope,
      output: options.output ?? 'text',
      showOrigin: false,
      trace: false,
    };
  }

  createConfigDelete(path: string, options: ConfigCommonOptions = {}): ConfigCommandLine {
    return {
      command: 'config',
      action: 'delete',
      cwd: this.resolveCwd(options.cwd),
      path,
      scope: options.scope,
      output: options.output ?? 'text',
      showOrigin: false,
      trace: false,
    };
  }

  createConfigEdit(options: ConfigCommonOptions = {}): ConfigCommandLine {
    return {
      command: 'config',
      action: 'edit',
      cwd: this.resolveCwd(options.cwd),
      scope: options.scope,
      output: options.output ?? 'text',
      showOrigin: false,
      trace: false,
    };
  }

  createRegistry(action: UAPKGRegistryAction, options: RegistryCommandLineOptions = {}): RegistryCommandLine {
    return {
      command: 'registry',
      action,
      cwd: this.resolveCwd(options.cwd),
      name: options.name,
      url: options.url,
      refType: options.refType,
      refValue: options.refValue,
      scope: options.scope,
      output: options.output ?? 'text',
    };
  }

  createPack(options: PackCommandLineOptions = {}): PackCommandLine {
    return {
      command: 'pack',
      ...(options.ignoreScripts ? { ignoreScripts: true } : {}),
      cwd: this.resolveCwd(options.cwd),
      dryRun: options.dryRun === true,
      allowMissingLfs: options.allowMissingLfs === true,
      outFile: options.outFile,
    };
  }

  private resolveCwd(cwd?: string) {
    return cwd ?? this.cwdProvider();
  }
}

export function createUAPKGCommandLineFactory(cwdProvider?: () => string) {
  return new UAPKGCommandLineFactory(cwdProvider);
}
