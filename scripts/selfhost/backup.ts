/**
 * `pnpm selfhost:backup [--to <dir>] [--env-file <path>] [--state-dir <path>]`
 *
 * Consistent copy of the fleet bucket plus `.state/` and `.env` (backup-lib.ts). celld is
 * stopped only for the delta copy; the downtime is printed and kept in the backup's manifest.
 * Default destination: deploy/selfhost/backups/<UTC timestamp> (gitignored, mode 0700).
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { gitCommit, loadBox, SELFHOST_DIR } from './backup-cli';
import { runBackup } from './backup-lib';

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    'env-file': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
const ctx = loadBox(resolve(values['env-file'] ?? join(SELFHOST_DIR, '.env')), values['state-dir']);
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const dest = resolve(values.to ?? join(SELFHOST_DIR, 'backups', stamp));
runBackup(ctx, dest, gitCommit());
process.stdout.write(`${dest}\n`);
