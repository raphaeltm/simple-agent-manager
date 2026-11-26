/** Explicit in-place rollback reuses upgrade's owned snapshot recovery and health checks. */
import { rmSync } from 'node:fs';
import { join } from 'node:path';

import { composeArgs, composeRunEnv } from './backup-lib.js';
import { checkoutWithTrackedModes } from './operator-files.js';
import { assertOperatorExecution } from './operator-only.js';
import { recoverRollbackState } from './rollback-state.js';
import { type BoxContext, recoverUpgrade, UPGRADE_PENDING_FILE } from './upgrade-lib.js';
import { assertRollbackReady } from './upgrade-preflight.js';

export interface ManualRollbackOptions {
  from: string;
  backupDir: string;
  rebuilds: string[];
  checkHealth: () => Promise<boolean>;
}

export async function runManualRollback(
  ctx: BoxContext,
  opts: ManualRollbackOptions
): Promise<void> {
  assertOperatorExecution();
  recoverRollbackState(ctx);
  if (
    !/^[a-f0-9]{40}$/.test(opts.from) ||
    opts.rebuilds.some((name) => !/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(name))
  ) {
    throw new Error('Rollback needs the original full commit SHA and valid service names');
  }
  assertRollbackReady(ctx);
  const status = ctx.run('git', ['status', '--porcelain', '--untracked-files=no']);
  if (status.status !== 0 || status.stdout.trim())
    throw new Error('Rollback requires a clean tracked checkout');
  const head = ctx.run('git', ['rev-parse', 'HEAD']);
  const operatorRef = head.stdout.trim();
  if (head.status !== 0 || !/^[a-f0-9]{40}$/.test(operatorRef))
    throw new Error('Cannot verify the operator checkout for rollback retry');
  try {
    await recoverUpgrade(ctx, opts.from, opts.backupDir, opts.rebuilds, {
      to: opts.from,
      checkHealth: opts.checkHealth,
    });
    rmSync(join(ctx.stateDir, UPGRADE_PENDING_FILE), { force: true });
    ctx.log('manual rollback completed; previous installation is healthy');
  } catch {
    try {
      ctx.run('docker', composeArgs(ctx, ['stop', 'celld']), composeRunEnv(ctx));
    } catch {
      /* best effort */
    }
    try {
      const checkout = checkoutWithTrackedModes(ctx.run, operatorRef, ctx.log);
      if (checkout.status === 0) ctx.run('pnpm', ['install', '--frozen-lockfile']);
    } catch {
      /* best effort; keep the application stopped */
    }
    throw new Error(
      'Manual rollback did not complete; keep celld stopped and retry the same rollback command. ' +
        `If the helper is unavailable, restore operator checkout ${operatorRef} and run pnpm install --frozen-lockfile first`
    );
  }
}
