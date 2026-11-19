/**
 * `pnpm selfhost:restore --from <backup dir> [--box-env <path>] [--state-dir <path>]`
 *
 * Restores a `pnpm selfhost:backup` into an EMPTY install (backup-lib.ts runRestore): the
 * CELLD_BUCKET in the target .env must hold no objects and the target .state/ no platform keys.
 * Supply an existing private target .env with its fresh bucket settings; it is never overwritten.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadBox, log, SELFHOST_DIR } from './backup-cli';
import { composeArgs, runRestore } from './backup-lib';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    'encryption-key-file': { type: 'string' },
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
if (!values.from) throw new Error('--from <backup directory> is required');
const from = resolve(values.from);
const envFile = resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env'));
const ctx = loadBox(envFile, values['state-dir'], values['encryption-key-file']);
const manifest = runRestore(ctx, from);
log(`restored backup of ${manifest.createdAt} (SAM ${manifest.samCommit ?? 'unknown commit'})`);
log('start the stack with the SAME SAM checkout the backup was taken with:');
if (manifest.samCommit) log(`  git checkout ${manifest.samCommit}`);
log(
  `  docker ${composeArgs(ctx, ['up', '-d'])
    .map((arg) => `'${arg.replaceAll("'", "'\"'\"'")}'`)
    .join(' ')}`
);
log(`  curl -fsS https://api.$SAM_DOMAIN/health`);
