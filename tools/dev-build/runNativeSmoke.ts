import { smokeNativeDevelopmentInstallation } from './NativeDevelopmentSmoke.ts';

const args = process.argv.slice(2).filter((argument) => argument !== '--');
if (args.length !== 2 || args[0] !== '--launcher') {
  throw new Error('Usage: vp exec node tools/dev-build/runNativeSmoke.ts --launcher <development-executable>');
}
smokeNativeDevelopmentInstallation(args[1]);
