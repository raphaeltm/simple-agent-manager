/**
 * `pnpm selfhost:upgrade --to <ref> [--box-env <path>] [--state-dir <dir>]`
 *
 * Fetch and check out a SAM git ref, migrate, deploy, restart the stack only when its compose
 * inputs changed, verify health and print how to roll back (upgrade-lib.ts).
 *
 * It takes NO automatic backup. Copy the fleet bucket (CELLD_BUCKET) and the .state directory
 * yourself first: an upgrade that carries a D1 migration can only be rolled back from such a copy.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { loadBox, runUpgrade, SELFHOST_DIR } from './upgrade-lib.js';

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
  },
});
if (!values.to) {
  throw new Error(
    '--to <git ref> is required (a tag, branch or commit). selfhost:upgrade takes no automatic ' +
      'backup: copy the fleet bucket and .state first'
  );
}
const ctx = loadBox(resolve(values['box-env'] ?? join(SELFHOST_DIR, '.env')), values['state-dir']);
const port = ctx.box.CELLD_PORT ?? '8080';

await runUpgrade(ctx, {
  to: values.to,
  checkHealth: async () => {
    // Same probe selfhost:deploy uses: the Worker on loopback, addressed as api.<domain>.
    const res = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { host: `api.${ctx.box.SAM_DOMAIN ?? ''}`, 'x-forwarded-proto': 'https' },
    }).catch(() => null);
    return res?.ok ?? false;
  },
});
