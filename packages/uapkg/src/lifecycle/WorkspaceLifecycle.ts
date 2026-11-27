import { runWorkspaceLifecycle, type WorkspaceLifecycleOptions } from '@uapkg/lifecycle';
import type { CompositionRoot } from '#cli/app/CompositionRoot.ts';
import { WorkspaceRuntime } from '#cli/lifecycle/WorkspaceRuntime.ts';

type InstallLifecycleInput = Omit<
  WorkspaceLifecycleOptions,
  'workspaceRoot' | 'config' | 'withVerifiedSnapshot' | 'runtime'
> & { frozen: boolean };

export class WorkspaceLifecycle {
  constructor(private readonly root: CompositionRoot) {}

  install({ frozen, ...options }: InstallLifecycleInput) {
    return runWorkspaceLifecycle({
      ...options,
      workspaceRoot: this.root.cwd,
      config: this.root.config.getAll(),
      withVerifiedSnapshot: (release, use) => this.root.installer.withVerifiedSnapshot(release, use),
      runtime: new WorkspaceRuntime(this.root, { frozen, refresh: options.refresh }),
    });
  }
}
