/**
 * `pnpm selfhost:upgrade --to <ref> [--box-env <path>] [--state-dir <dir>] [--secrets <path>]`
 *
 * Fetch and check out a SAM git ref, migrate, deploy, restart the stack only when its compose
 * inputs changed, verify health and print how to roll back (upgrade-lib.ts).
 *
 * Every upgrade takes an encrypted snapshot and automatically restores it on failure.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { celldPort, SELFHOST_DIR, waitForHealth } from './deploy-steps.js';
import { assertOperatorExecution } from './operator-only.js';
import { loadBox, runUpgrade } from './upgrade-lib.js';

assertOperatorExecution();

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
    secrets: { type: 'string' },
    'backup-to': { type: 'string' },
    'encryption-key-file': { type: 'string' },
  },
});
if (!values.to) throw new Error('--to <git ref> is required (a tag, branch or commit)');
// Each is passed on to every `pnpm selfhost:deploy` the upgrade runs (upgrade-lib.ts).
const ctx = loadBox(
  resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env')),
  values['state-dir'],
  values.secrets,
  values['encryption-key-file']
);
const port = celldPort(ctx.box);

await runUpgrade(ctx, {
  to: values.to,
  ...(values['backup-to'] ? { backupDir: resolve(values['backup-to']) } : {}),
  checkHealth: async () => {
    try {
      await waitForHealth(port, ctx.box.SAM_DOMAIN ?? '');
      return true;
    } catch {
      return false;
    }
  },
});
