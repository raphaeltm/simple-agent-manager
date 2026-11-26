/**
 * `pnpm selfhost:restore --from <backup dir> [--box-env <path>] [--state-dir <path>]`
 *
 * Restores a `pnpm selfhost:backup` into an EMPTY install (backup-lib.ts runRestore): the
 * CELLD_BUCKET in the target .env must hold no objects and the target .state/ no platform keys.
 * Supply an existing private target .env with its fresh bucket settings; it is never overwritten.
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { LOCAL_BUNDLE_SUBDIR } from '../../deploy/selfhost/key-agent/bundle-store.ts';
import { loadBox, log, SELFHOST_DIR } from './backup-cli';
import { composeArgs, runRestore } from './backup-lib';
import { expectedComposeProjectFor } from './install-record';
import { useOperatorUmask } from './operator-files';

const { values } = parseArgs({
  options: {
    from: { type: 'string' },
    'print-project': { type: 'boolean', default: false },
    'encryption-key-file': { type: 'string' },
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
// Operator commands never inherit a restrictive umask (operator-files.ts).
useOperatorUmask();
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
if (existsSync(join(ctx.stateDir, LOCAL_BUNDLE_SUBDIR))) {
  // A sealed backup holds no key (backup-lib.ts isKeyServiceSecretPath): the clone needs one.
  const credentials = join(ctx.stateDir, 'key-agent', 'credentials');
  log(
    'This backup is sealed. Before --init, give the target the key: with the file key, copy the ' +
      `copy you kept off the box to ${join(ctx.stateDir, 'key-agent', 'kek')} (mode 0600); with a ` +
      `Vault/OpenBao transit key or stored AWS credentials, restore transit-secret-id, ` +
      `transit-token or aws-credentials from your separate secure copy into ${credentials}/ ` +
      "(directory 0700, files 0600); with a cloud key, grant this VM's identity the same key. " +
      "--init then seals the clone's own identity."
  );
}
log('Recover with the SAME SAM checkout the backup was taken with:');
if (manifest.samCommit) log(`  git checkout ${manifest.samCommit}`);
log(
  `  Set COMPOSE_PROJECT_NAME in the target .env to ${expectedComposeProjectFor(ctx.box, ctx.stateDir)} before running --init`
);
log(
  `  pnpm selfhost:deploy --init --env-file '${envFile.replaceAll("'", "'\"'\"'")}' --state-dir '${ctx.stateDir.replaceAll("'", "'\"'\"'")}'`
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
if (ctx.box.SAM_DOMAIN) {
  const health = `https://api.${ctx.box.SAM_DOMAIN}/health`;
  log(`  curl -fsS '${health.replaceAll("'", "'\"'\"'")}'`);
} else {
  log('Set SAM_DOMAIN in the target .env before checking the restored API health');
}
