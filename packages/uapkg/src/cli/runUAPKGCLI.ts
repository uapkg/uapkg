import { requestsDebugInfo, runDebugInfo } from '#cli/cli/DebugInfo.ts';
import { parseUAPKGCommandLine } from '#cli/cli/parseCommandLine.ts';
import { launcherRetryInvocation } from '#cli/cli/launcherRetryInvocation.ts';

export async function runUAPKGCLI(rawArgv = process.argv) {
  // Consume launcher-only retry metadata before any package-authored child can inherit it.
  const retryFlags = process.env.UAPKG_LAUNCHER_EXECUTABLE ? process.env.UAPKG_INTERNAL_RETRY_FLAGS : undefined;
  delete process.env.UAPKG_INTERNAL_RETRY_FLAGS;
  if (rawArgv.slice(2).length === 1 && rawArgv[2] === '--internal-lifecycle-worker') {
    return (await import('@uapkg/lifecycle')).runLifecycleWorker();
  }
  if (requestsDebugInfo(rawArgv.slice(2))) return await runDebugInfo();
  const commandLine = await parseUAPKGCommandLine(rawArgv);
  const { UAPKGApplication } = await import('#cli/app/UAPKGApplication.ts');
  return await new UAPKGApplication().run(commandLine, launcherRetryInvocation(rawArgv.slice(2), retryFlags));
}
