/** Upgrade completion is committed before recovery metadata is removed. */
import {
  closeSync,
  existsSync,
  fsyncSync,
  lstatSync,
  openSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { isAbsolute, join } from 'node:path';

import { assertPrivateFile, replacePrivateFile } from './secret-files.js';

export const UPGRADE_PENDING_FILE = 'upgrade-pending.json';
function sync(path: string): void {
  const fd = openSync(path, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}
export function clearUpgradeJournal(stateDir: string): void {
  rmSync(join(stateDir, UPGRADE_PENDING_FILE), { force: true });
  sync(stateDir);
}
export function completeUpgradeJournal(
  stateDir: string,
  record: { from: string; to: string; backupDir: string },
  beforeClear?: () => void
): void {
  replacePrivateFile(
    join(stateDir, UPGRADE_PENDING_FILE),
    JSON.stringify({ ...record, phase: 'completed' })
  );
  // A caller's own completion record lands while this completed marker still proves success.
  beforeClear?.();
  clearUpgradeJournal(stateDir);
}

/** The durable completed marker of a healthy upgrade to `to`, if one is present. */
export function upgradeCompletedTo(stateDir: string, to: string): boolean {
  const path = join(stateDir, UPGRADE_PENDING_FILE);
  if (!existsSync(path)) return false;
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object') return false;
    const record = raw as Record<string, unknown>;
    return record.phase === 'completed' && record.to === to && record.from !== to;
  } catch {
    return false;
  }
}
/** A terminal marker authorizes cleanup, never restoration of its old snapshot. */
export function readPendingFrom(stateDir: string, head: string): string | null {
  const path = join(stateDir, UPGRADE_PENDING_FILE);
  if (!existsSync(path)) return null;
  let record: Record<string, unknown>;
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid record');
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid record');
    record = raw as Record<string, unknown>;
    if (typeof record.from !== 'string' || !/^[0-9a-f]{40}$/.test(record.from))
      throw new Error('Invalid ref');
  } catch {
    throw new Error(
      `${path} is not a record this upgrade wrote; preserve the target and recovery metadata for inspection`
    );
  }
  if (record.phase === undefined) return record.from as string;
  if (
    record.phase !== 'completed' ||
    typeof record.to !== 'string' ||
    !/^[0-9a-f]{40}$/.test(record.to) ||
    record.to !== head ||
    typeof record.backupDir !== 'string' ||
    !isAbsolute(record.backupDir)
  )
    throw new Error(
      'Upgrade verification or completion is uncertain; preserve live data and use explicit rollback only after inspection'
    );
  assertPrivateFile(path);
  // Reestablish durability if the completed rename was observed before a failed directory sync.
  sync(path);
  sync(stateDir);
  clearUpgradeJournal(stateDir);
  return null;
}
