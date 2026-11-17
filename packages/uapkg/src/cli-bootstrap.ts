import Config from '@uapkg/config';
import Log, { configureLogger } from '@uapkg/log';
import { registerLauncherNoticeFooter } from '#cli/cli/LauncherNotices.ts';
import { runUAPKGCLI } from '#cli/cli/runUAPKGCLI.ts';

registerLauncherNoticeFooter();
Config.reload({ cwd: process.cwd() });
configureLogger({
  isVerboseEnabled: () => Config.get('term.verbose') === true,
  isQuietEnabled: () => Config.get('term.quiet') === true,
});

runUAPKGCLI(process.argv)
  .then((exitCode) => {
    process.exitCode = exitCode;
  })
  .catch((error) => {
    Log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
