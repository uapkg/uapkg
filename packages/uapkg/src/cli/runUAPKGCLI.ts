import { requestsDebugInfo, runDebugInfo } from '#cli/cli/DebugInfo.ts';
import { parseUAPKGCommandLine } from '#cli/cli/parseCommandLine.ts';

export async function runUAPKGCLI(rawArgv = process.argv) {
  if (requestsDebugInfo(rawArgv.slice(2))) return await runDebugInfo();
  const commandLine = await parseUAPKGCommandLine(rawArgv);
  const { UAPKGApplication } = await import('#cli/app/UAPKGApplication.ts');
  return await new UAPKGApplication().run(commandLine);
}
