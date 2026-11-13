import type { UAPKGBuildMode } from '@uapkg/common';
import type { DevBuildMode, DevBuildOptions } from './types.ts';

const BUILD_MODE_FLAGS = new Set(['--development', '--production']);

export function parseDevBuildOptions(command: DevBuildMode, args: string[]): DevBuildOptions {
  const optionArgs = args.filter((arg) => arg !== '--');
  const hasDevelopment = optionArgs.includes('--development');
  const hasProduction = optionArgs.includes('--production');

  if (hasDevelopment && hasProduction) {
    throw new Error('[dev-build] --development and --production cannot be used together.');
  }

  if (command !== 'build' && (hasDevelopment || hasProduction)) {
    const commandDescription =
      command === 'link' || command === 'watch'
        ? `${command} always uses a development build`
        : `${command} does not build the CLI`;
    throw new Error(`[dev-build] Build mode flags are not supported by ${command}; ${commandDescription}.`);
  }

  const allowedFlags = getAllowedFlags(command);
  const unsupportedFlag = optionArgs.find((arg) => !allowedFlags.has(arg));
  if (unsupportedFlag) {
    throw new Error(`[dev-build] Unsupported option for ${command}: ${unsupportedFlag}`);
  }

  return {
    force: optionArgs.includes('--force'),
    buildMode: resolveBuildMode(hasProduction),
  };
}

function getAllowedFlags(command: DevBuildMode) {
  if (command === 'build') {
    return BUILD_MODE_FLAGS;
  }

  if (command === 'link') {
    return new Set(['--force']);
  }

  return new Set<string>();
}

/**
 * Resolves the build mode based on the presence of the `--production` flag.
 *
 * @param hasProduction Whether the `--production` argument was supplied
 * @returns The resolved build mode, with explicit production superceding development mode. If neither is supplied, defaults to development mode.
 */
function resolveBuildMode(hasProduction: boolean): UAPKGBuildMode {
  return hasProduction ? 'production' : 'development';
}
