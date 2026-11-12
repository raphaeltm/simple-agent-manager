/**
 * `pnpm selfhost:upgrade --to <ref> [--skip-backup] [--backup-to <dir>] [--box-env <path>]`
 *
 * Fetch and check out a SAM git ref, back up, migrate, deploy, restart the stack only when its
 * compose inputs changed, verify health and print how to roll back (upgrade-lib.ts).
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadBox, SELFHOST_DIR } from './backup-cli';
import { runUpgrade } from './upgrade-lib';

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    'skip-backup': { type: 'boolean', default: false },
    'backup-to': { type: 'string' },
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
if (!values.to) throw new Error('--to <git ref> is required (a tag, branch or commit)');
const ctx = loadBox(resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env')), values['state-dir']);
const port = ctx.box.CELLD_PORT ?? '8080';
const stamp = new Date().toISOString().replace(/[:.]/g, '-');

await runUpgrade(ctx, {
  to: values.to,
  backupDir: values['skip-backup']
    ? null
    : resolve(values['backup-to'] ?? join(SELFHOST_DIR, 'backups', `pre-upgrade-${stamp}`)),
  checkHealth: async () => {
    // Same probe selfhost:deploy uses: the Worker on loopback, addressed as api.<domain>.
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { host: `api.${ctx.box.SAM_DOMAIN ?? ''}`, 'x-forwarded-proto': 'https' },
    }).catch(() => null);
    return res?.ok ?? false;
  },
});
