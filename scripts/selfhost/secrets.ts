/**
 * `pnpm selfhost:secrets <command> [--box-env <path>] [--state-dir <dir>]`
 *
 *   status    which key provider seals the Worker secrets, why, and the bundles on the box
 *
 * Every command prints names, paths, fingerprints and ids only: never a key or a secret value.
 */
import { readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { SELFHOST_DIR } from './backup-cli';
import { assertPrivateFile, parseDotenv } from './secret-files';
import { describeKeyStatus } from './secrets-status';

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
const envFile = resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env'));
assertPrivateFile(envFile);
const box = parseDotenv(readFileSync(envFile, 'utf8'), envFile);
const stateDir = resolve(
  dirname(envFile),
  values['state-dir'] ?? box.SAM_SELFHOST_STATE_DIR ?? '.state'
);

const [command] = positionals;
try {
  switch (command) {
    case 'status':
      for (const line of describeKeyStatus(box, stateDir)) console.log(line);
      break;
    default:
      throw new Error('usage: pnpm selfhost:secrets status [--box-env PATH] [--state-dir DIR]');
  }
} catch (error) {
  console.error(`[selfhost] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
