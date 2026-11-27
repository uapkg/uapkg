import type { Argv } from 'yargs';
import type { UAPKGCommandLine } from '#cli/cli/UAPKGCommandLine.ts';
import type { UAPKGCommandModule } from '#cli/cli/parsing/contracts/UAPKGCommandModule.ts';
import { AddCommandModule } from '#cli/cli/parsing/modules/AddCommandModule.ts';
import { ConfigCommandModule } from '#cli/cli/parsing/modules/ConfigCommandModule.ts';
import { InitCommandModule } from '#cli/cli/parsing/modules/InitCommandModule.ts';
import { InstallCommandModule } from '#cli/cli/parsing/modules/InstallCommandModule.ts';
import { LifecycleCommandModule } from '#cli/cli/parsing/modules/LifecycleCommandModule.ts';
import { ListCommandModule } from '#cli/cli/parsing/modules/ListCommandModule.ts';
import { LoginCommandModule } from '#cli/cli/parsing/modules/LoginCommandModule.ts';
import { LogoutCommandModule } from '#cli/cli/parsing/modules/LogoutCommandModule.ts';
import { OutdatedCommandModule } from '#cli/cli/parsing/modules/OutdatedCommandModule.ts';
import { PermissionsCommandModule } from '#cli/cli/parsing/modules/PermissionsCommandModule.ts';
import { PackCommandModule } from '#cli/cli/parsing/modules/PackCommandModule.ts';
import { ProjectGetNameCommandModule } from '#cli/cli/parsing/modules/ProjectGetNameCommandModule.ts';
import { PublishCommandModule } from '#cli/cli/parsing/modules/PublishCommandModule.ts';
import { RegistryCommandModule } from '#cli/cli/parsing/modules/RegistryCommandModule.ts';
import { RemoveCommandModule } from '#cli/cli/parsing/modules/RemoveCommandModule.ts';
import { RequestsCommandModule } from '#cli/cli/parsing/modules/RequestsCommandModule.ts';
import { UpdateCommandModule } from '#cli/cli/parsing/modules/UpdateCommandModule.ts';
import { WhoamiCommandModule } from '#cli/cli/parsing/modules/WhoamiCommandModule.ts';
import { WhyCommandModule } from '#cli/cli/parsing/modules/WhyCommandModule.ts';

export class UAPKGParserRegistry {
  constructor(
    private readonly modules: UAPKGCommandModule[] = [
      new InitCommandModule(),
      new AddCommandModule(),
      new InstallCommandModule(),
      new UpdateCommandModule(),
      new RemoveCommandModule(),
      new OutdatedCommandModule(),
      new WhyCommandModule(),
      new ListCommandModule(),
      new PackCommandModule(),
      new PermissionsCommandModule(),
      new ProjectGetNameCommandModule(),
      new ConfigCommandModule(),
      new RegistryCommandModule(),
      new LoginCommandModule(),
      new LogoutCommandModule(),
      new WhoamiCommandModule(),
      new PublishCommandModule(),
      new LifecycleCommandModule(),
      new RequestsCommandModule(),
    ],
  ) {}

  registerAll(parser: Argv, sink: { set: (commandLine: UAPKGCommandLine) => void }) {
    let next = parser;
    for (const module of this.modules) {
      next = module.register(next, sink);
    }

    return next;
  }
}
