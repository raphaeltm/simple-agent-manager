/** Test-only Go HTTP producer → Worker callback → sleep → scheduled wake proof. */
import { execFileSync } from 'node:child_process';
import { accessSync, constants, mkdirSync, statSync } from 'node:fs';
import { delimiter, dirname, isAbsolute, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
mkdirSync(resolve(root, '.codex/tmp'), { recursive: true });
const output = resolve(root, '.codex/tmp/provider-limit-callbacks.json');
const env = {
  ...process.env,
  GOMAXPROCS: process.env.GOMAXPROCS ?? '2',
  TEST_PROVIDER_LIMIT_CALLBACK_OUTPUT: output,
};
// This developer-only runner resolves caller-selected tools before execution.
// Provider input never selects an executable or modifies this environment.
function executablePath(name) {
  for (const directory of (process.env.PATH ?? '').split(delimiter)) {
    if (!isAbsolute(directory)) continue;
    const candidate = resolve(directory, name);
    try {
      if (!statSync(candidate).isFile()) continue;
      accessSync(candidate, constants.X_OK);
      return candidate;
    } catch {
      // Continue to the next absolute tool directory.
    }
  }
  throw new Error(`Required test executable not found: ${name}`);
}
const goPath = executablePath('go');
const pnpmPath = executablePath('pnpm');
execFileSync(
  goPath,
  [
    'test',
    '-p',
    '1',
    './internal/server',
    '-run',
    'ProviderLimitRecordedFixtureCallbacks',
    '-count=1',
  ],
  { cwd: resolve(root, 'packages/vm-agent'), env, stdio: 'inherit' }
);
execFileSync(
  pnpmPath,
  ['exec', 'vitest', 'run', 'tests/integration/provider-limit-lifecycle.test.ts', '--maxWorkers=1'],
  { cwd: resolve(root, 'apps/api'), env, stdio: 'inherit' }
);

execFileSync(
  pnpmPath,
  [
    'exec',
    'vitest',
    'run',
    '--config',
    'vitest.workers.config.ts',
    'tests/workers/provider-limit-full-restore.test.ts',
  ],
  { cwd: resolve(root, 'apps/api'), env, stdio: 'inherit' }
);
