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
import { expectedComposeProjectFor } from './install-record';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    'print-project': { type: 'boolean', default: false },
    'encryption-key-file': { type: 'string' },
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
if (!values.from) throw new Error('--from <backup directory> is required');
const from = resolve(values.from);
const envFile = resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env'));
const ctx = loadBox(envFile, values['state-dir'], values['encryption-key-file']);
if (values['print-project']) {
  process.stdout.write(`${runRestore(ctx, from, 'project')}\n`);
  process.exit(0);
}
const manifest = runRestore(ctx, from);
log(`restored backup of ${manifest.createdAt} (SAM ${manifest.samCommit ?? 'unknown commit'})`);
log('Recover with the SAME SAM checkout the backup was taken with:');
if (manifest.samCommit) log(`  git checkout ${manifest.samCommit}`);
log(
  `  pnpm selfhost:deploy --init --env-file '${envFile.replaceAll("'", "'\"'\"'")}' --state-dir '${ctx.stateDir.replaceAll("'", "'\"'\"'")}'`
);
log(
  `  Set COMPOSE_PROJECT_NAME in the target .env to ${expectedComposeProjectFor(ctx.box, ctx.stateDir)}, then repeat --init to record the target identity`
);
log(
  `  SAM_SELFHOST_STATE_DIR='${ctx.stateDir.replaceAll("'", "'\"'\"'")}' docker ${composeArgs(
    {
      ...ctx,
      box: { ...ctx.box, COMPOSE_PROJECT_NAME: expectedComposeProjectFor(ctx.box, ctx.stateDir) },
    },
    ['up', '-d']
  )
    .map((arg) => `'${arg.replaceAll("'", "'\"'\"'")}'`)
    .join(' ')}`
);
log(
  `  pnpm selfhost:deploy --env-file '${envFile.replaceAll("'", "'\"'\"'")}' --state-dir '${ctx.stateDir.replaceAll("'", "'\"'\"'")}'`
);
log(`  curl -fsS https://api.$SAM_DOMAIN/health`);
