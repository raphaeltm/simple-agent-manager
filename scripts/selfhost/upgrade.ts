/**
 * `pnpm selfhost:upgrade --to <ref> [--box-env <path>] [--state-dir <dir>] [--secrets <path>]`
 *
 * Fetch and check out a SAM git ref, migrate, deploy, restart the stack only when its compose
 * inputs changed, verify health and print how to roll back (upgrade-lib.ts).
 *
 * Every upgrade takes an encrypted snapshot and automatically restores it on failure.
 *
 * `--adopt-legacy --from <deployed full sha>` first moves a pre-L24 install off the shared
 * `sam-selfhost` Compose project (legacy-adoption.ts), then upgrades it the same way.
 */
import { join, resolve } from 'node:path';
import { parseArgs } from 'node:util';

import { celldPort, SELFHOST_DIR, waitForHealth } from './deploy-steps.js';
import { runLegacyAdoption } from './legacy-adoption.js';
import { useOperatorUmask } from './operator-files.js';
import { assertOperatorExecution } from './operator-only.js';
import { loadBox, runUpgrade } from './upgrade-lib.js';
import { runManualRollback } from './upgrade-rollback.js';

assertOperatorExecution();
// Operator commands never inherit a restrictive umask (operator-files.ts).
useOperatorUmask();

const { values } = parseArgs({
  options: {
    to: { type: 'string' },
    'box-env': { type: 'string' },
    'state-dir': { type: 'string' },
    secrets: { type: 'string' },
    'backup-to': { type: 'string' },
    'rollback-from': { type: 'string' },
    rebuild: { type: 'string', multiple: true },
    'encryption-key-file': { type: 'string' },
    'adopt-legacy': { type: 'boolean', default: false },
    from: { type: 'string' },
    'adoption-backup-to': { type: 'string' },
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

const checkHealth = async () => {
  try {
    await waitForHealth(port, ctx.box.SAM_DOMAIN ?? '');
    return true;
  } catch {
    return false;
  }
};

if (values['adopt-legacy'] && values['rollback-from'])
  throw new Error('--adopt-legacy and --rollback-from cannot be combined');
if (!values['adopt-legacy'] && (values.from || values['adoption-backup-to']))
  throw new Error('--from and --adoption-backup-to are only used with --adopt-legacy');

if (values['adopt-legacy']) {
  if (!values.from) throw new Error('--adopt-legacy needs --from <full SHA the stack runs>');
  if (values.rebuild?.length) throw new Error('--rebuild is only used with --rollback-from');
  await runLegacyAdoption(ctx, {
    to: values.to,
    from: values.from,
    checkHealth,
    upgrade: runUpgrade,
    ...(values['adoption-backup-to'] ? { backupDir: resolve(values['adoption-backup-to']) } : {}),
    ...(values['backup-to'] ? { upgradeBackupDir: resolve(values['backup-to']) } : {}),
  });
} else if (values['rollback-from']) {
  await runManualRollback(ctx, {
    from: values.to,
    backupDir: resolve(values['rollback-from']),
    rebuilds: values.rebuild ?? [],
    checkHealth,
  });
} else {
  if (values.rebuild?.length) throw new Error('--rebuild is only used with --rollback-from');
  await runUpgrade(ctx, {
    to: values.to,
    ...(values['backup-to'] ? { backupDir: resolve(values['backup-to']) } : {}),
    checkHealth,
  });
}
