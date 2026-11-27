import { lstat, realpath } from 'node:fs/promises';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import type { InstallPath } from '@uapkg/common-schema';

function outside(root: string, target: string): boolean {
  const path = relative(root, target);
  return path === '..' || path.startsWith('..' + sep) || isAbsolute(path);
}

/** Resolve a package destination against the workspace, including existing linked parent directories. */
export async function workspaceInstallPath(workspace: string, installPath: InstallPath): Promise<string> {
  const root = resolve(workspace);
  const target = resolve(root, installPath);
  if (target === root || outside(root, target)) throw new Error('Install path is outside the workspace: ' + target);
  const physicalRoot = await realpath(root);
  let parent = dirname(target);
  while (true) {
    try {
      if (outside(physicalRoot, await realpath(parent)))
        throw new Error('Install parent is outside the workspace: ' + parent);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT' || parent === root) throw error;
      parent = dirname(parent);
    }
  }
  try {
    if ((await lstat(target)).isSymbolicLink()) throw new Error('Install path is a symbolic link: ' + target);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return target;
}
