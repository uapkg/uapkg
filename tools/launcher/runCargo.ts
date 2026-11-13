import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Rustup selects rust-toolchain.toml from cwd, not --manifest-path.
const args = process.argv.slice(2);
// Vite forwards the script-argument delimiter. Remove that delimiter before
// Cargo interprets it as the boundary between Cargo and test-harness options.
const separator = args.indexOf('--');
if (separator !== -1) args.splice(separator, 1);
const result = spawnSync('cargo', args, {
  cwd: fileURLToPath(new URL('../../launcher/', import.meta.url)),
  stdio: 'inherit',
  env: {
    ...process.env,
    UAPKG_TEST_NODE: process.execPath,
    ...(args[0] === 'clippy' ? { CARGO_BUILD_WARNINGS: 'deny' } : {}),
  },
});
if (result.error) {
  process.stderr.write(`Could not run Cargo: ${result.error.message}. Install Rustup and retry.\n`);
}
process.exit(result.status ?? 1);
