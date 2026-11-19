/** Refuse upgrades whose installation cannot safely remove its cache during rollback. */
import type { BoxContext } from './backup-lib.js';
import {
  composeProjectFor,
  expectedComposeProjectFor,
  readInstallRecord,
} from './install-record.js';

export function assertRollbackReady(ctx: Pick<BoxContext, 'box' | 'stateDir'>): void {
  const project = composeProjectFor(ctx.box, ctx.stateDir);
  if (project !== expectedComposeProjectFor(ctx.box, ctx.stateDir)) {
    throw new Error(
      'Upgrade refused: legacy shared compose project cannot safely roll back; migrate to an installation-specific compose project before upgrading'
    );
  }
  let records;
  try {
    records = readInstallRecord(ctx.stateDir);
  } catch {
    throw new Error('Upgrade refused: cannot verify installation compose creation receipt');
  }
  const matches = records.filter(
    (entry) =>
      entry.cloud === 'box' &&
      entry.kind === 'compose-project' &&
      entry.name === project &&
      entry.action === 'created' &&
      !entry.removedAt
  );
  if (matches.length !== 1) {
    throw new Error(
      'Upgrade refused: missing installation compose creation receipt; deploy the installation-specific project before upgrading'
    );
  }
}
