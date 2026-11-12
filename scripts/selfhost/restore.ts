/**
 * `pnpm selfhost:restore --from <backup dir> [--env-file <path>] [--state-dir <path>]`
 *
 * Restores a `pnpm selfhost:backup` into an EMPTY install (backup-lib.ts runRestore): the
 * CELLD_BUCKET in the target .env must hold no objects and the target .state/ no platform keys.
 * With no target .env, the backup's .env is installed first (same bucket, e.g. after wiping it).
 */
import { copyFileSync, existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadBox, log, SELFHOST_DIR } from './backup-cli';
import { ENV_FILE, runRestore } from './backup-lib';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    'env-file': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
if (!values.from) throw new Error('--from <backup directory> is required');
const from = resolve(values.from);
const envFile = resolve(values['env-file'] ?? join(SELFHOST_DIR, '.env'));
if (!existsSync(envFile)) {
  copyFileSync(join(from, ENV_FILE), envFile);
  log(`installed ${envFile} from the backup`);
}
const ctx = loadBox(envFile, values['state-dir']);
const manifest = runRestore(ctx, from);
log(`restored backup of ${manifest.createdAt} (SAM ${manifest.samCommit ?? 'unknown commit'})`);
log('start the stack with the SAME SAM checkout the backup was taken with:');
if (manifest.samCommit) log(`  git checkout ${manifest.samCommit}`);
log(`  docker compose -f ${join(SELFHOST_DIR, 'docker-compose.yml')} up -d`);
log(`  curl -fsS https://api.$SAM_DOMAIN/health`);
