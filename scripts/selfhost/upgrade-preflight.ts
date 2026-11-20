import { isAbsolute } from 'node:path';

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

/** A pending record without its original snapshot cannot safely authorize another deployment. */
export function pendingBackupDirectory(pending: unknown): string {
  if (
    typeof pending !== 'object' ||
    pending === null ||
    !('backupDir' in pending) ||
    typeof pending.backupDir !== 'string' ||
    !isAbsolute(pending.backupDir)
  ) {
    throw new Error(
      'unfinished upgrade has no recorded encrypted snapshot; recover the original installation before retrying'
    );
  }
  return pending.backupDir;
}

/** Legacy records cannot prove which image changes an interrupted deployment applied. */
export function pendingUpgradeTarget(pending: unknown): string | null {
  if (typeof pending !== 'object' || pending === null || !('to' in pending)) return null;
  return typeof pending.to === 'string' && /^[a-f0-9]{40}$/.test(pending.to) ? pending.to : null;
}

export function assertPendingUpgradeTarget(pending: unknown, to: string): void {
  if (pendingUpgradeTarget(pending) !== to)
    throw new Error(
      'Unfinished upgrade target differs or is unrecorded; recover with the explicit rollback command before choosing another target'
    );
}
