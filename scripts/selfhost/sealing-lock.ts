/**
 * One sealing operation per box at a time, from the first read of the sealed state to the
 * published Worker: a deploy, `secrets rotate`, `secrets switch` and `secrets migrate`.
 *
 * The head lock (bundle-head.ts commitHead) makes each head write a compare-and-set, but a deploy
 * publishes its Worker minutes after it commits its head. Two overlapping deploys could commit A,
 * then B (derived from A), publish B, and then publish A: the running Worker would use A while
 * the head names B. This lock spans the whole operation, so that cannot interleave.
 *
 * A rotation, switch or migration runs its own deploys as child processes. They inherit the lock
 * through SAM_SELFHOST_SEALING_LOCK, which names the holder's pid, and re-enter it only while the
 * lock file still names that same live holder: a stray variable alone never skips the lock.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { acquireLockFile } from '../../deploy/selfhost/key-agent/bundle-store.ts';
import { KEY_AGENT_DIR } from './key-service.js';

export const SEALING_LOCK_FILE = join(KEY_AGENT_DIR, 'sealing.lock');
export const SEALING_LOCK_ENV = 'SAM_SELFHOST_SEALING_LOCK';

/** The pid in the lock file, or null when there is none. */
function lockHolder(path: string): string | null {
  try {
    return readFileSync(path, 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Whether this process runs inside an operation that already holds the lock (a child deploy). */
function inherited(path: string): boolean {
  const holder = process.env[SEALING_LOCK_ENV]?.trim();
  return Boolean(holder) && lockHolder(path) === holder;
}

/**
 * Takes the box's sealing lock until the returned release is called (or the process exits), and
 * passes it on to child processes. A no-op release when the lock is already inherited.
 */
export async function acquireSealingLock(stateDir: string): Promise<() => void> {
  const path = join(stateDir, SEALING_LOCK_FILE);
  if (inherited(path)) return () => undefined;
  const release = await acquireLockFile(path);
  const before = process.env[SEALING_LOCK_ENV];
  process.env[SEALING_LOCK_ENV] = String(process.pid);
  let released = false;
  const done = () => {
    if (released) return;
    released = true;
    if (before === undefined) delete process.env[SEALING_LOCK_ENV];
    else process.env[SEALING_LOCK_ENV] = before;
    release();
  };
  process.once('exit', done);
  return () => {
    process.removeListener('exit', done);
    done();
  };
}

/** Runs `fn` holding the box's sealing lock (acquireSealingLock). */
export async function withSealingLock<T>(stateDir: string, fn: () => Promise<T>): Promise<T> {
  const release = await acquireSealingLock(stateDir);
  try {
    return await fn();
  } finally {
    release();
  }
}
