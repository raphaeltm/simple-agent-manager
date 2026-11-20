/** Private retry ownership for a restore that started from an empty bucket and state directory. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
  linkSync,
  lstatSync,
  openSync,
  readdirSync,
  readFileSync,
  readSync,
  rmSync,
  type Stats,
  writeSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import { prepareBackupParent } from './backup-destination';
import { assertBackupOutside, type BoxContext } from './backup-lib';
import { assertOperatorExecution } from './operator-only';
import { assertPrivateFile } from './secret-files';

function digest(path: string): string {
  const input = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    if (!fstatSync(input).isFile()) throw new Error('Restore retry requires regular files');
    const hash = createHash('sha256');
    const chunk = Buffer.alloc(64 * 1024);
    let count: number;
    while ((count = readSync(input, chunk, 0, chunk.length, null)) > 0)
      hash.update(chunk.subarray(0, count));
    return hash.digest('hex');
  } finally {
    closeSync(input);
  }
}

/** A torn state copy may contain only the exact leading bytes of its authenticated source. */
function exactPrefix(current: string, expected: string): boolean {
  const input = openSync(current, constants.O_RDONLY | constants.O_NOFOLLOW);
  const source = openSync(expected, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const actual = fstatSync(input),
      original = fstatSync(source);
    assertOwned(actual);
    if (!actual.isFile() || actual.nlink !== 1 || !original.isFile() || actual.size > original.size)
      return false;
    const a = Buffer.alloc(64 * 1024),
      b = Buffer.alloc(64 * 1024);
    let count: number;
    while ((count = readSync(input, a, 0, a.length, null)) > 0) {
      let offset = 0;
      while (offset < count) {
        const n = readSync(source, b, offset, count - offset, null);
        if (!n) return false;
        offset += n;
      }
      if (!a.subarray(0, count).equals(b.subarray(0, count))) return false;
    }
    return true;
  } finally {
    closeSync(input);
    closeSync(source);
  }
}

function assertOwned(stat: Stats): void {
  if (process.getuid !== undefined && stat.uid !== process.getuid())
    throw new Error('Restore retry contains foreign-owned data');
}
/** Existing partial output must be an exact subset of the authenticated snapshot. Never delete it. */
export function assertRestoreSubset(current: string, expected: string, partialState = false): void {
  assertOperatorExecution();
  const stat = lstatSync(current, { throwIfNoEntry: false });
  if (!stat) return;
  assertOwned(stat);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error('Restore retry contains an unsafe directory');
  for (const name of readdirSync(current)) {
    const path = join(current, name);
    const source = join(expected, name);
    const found = lstatSync(path);
    assertOwned(found);
    const original = lstatSync(source, { throwIfNoEntry: false });
    if (!original) throw new Error('Restore retry contains data outside its snapshot');
    if (found.isDirectory() && original.isDirectory())
      assertRestoreSubset(path, source, partialState);
    else if (
      !found.isFile() ||
      !original.isFile() ||
      found.nlink !== 1 ||
      original.nlink !== 1 ||
      (partialState ? !exactPrefix(path, source) : digest(path) !== digest(source))
    ) {
      throw new Error('Restore retry contains changed or unsafe data');
    }
  }
}

export interface RestoreProgress {
  resume: boolean;
  begin(): void;
  finish(): void;
}
export function restoreProgress(ctx: BoxContext, backup: string): RestoreProgress {
  assertOperatorExecution();
  const progressPath = `${resolve(ctx.stateDir)}.restore-progress.json`;
  const complete = `${resolve(ctx.stateDir)}.restore-complete.json`;
  let journal =
    lstatSync(progressPath, { throwIfNoEntry: false }) ||
    !lstatSync(complete, { throwIfNoEntry: false })
      ? progressPath
      : complete;
  assertBackupOutside(ctx, progressPath);
  assertBackupOutside(ctx, complete);
  const expected = JSON.stringify({
    format: 'sam-restore-progress/1',
    bucket: ctx.box.CELLD_BUCKET,
    state: resolve(ctx.stateDir),
    backup: resolve(backup),
    snapshot: digest(join(backup, '.sam-backup-manifest')),
  });
  const existing = lstatSync(journal, { throwIfNoEntry: false });
  const validate = (path = journal): void => {
    try {
      if (lstatSync(path).isSymbolicLink()) throw new Error('Invalid journal');
      assertPrivateFile(path);
      if (readFileSync(path, 'utf8') !== expected) throw new Error('Different restore');
    } catch {
      throw new Error(
        'Cannot verify restore retry ownership; preserve the partial target for inspection'
      );
    }
  };
  if (existing) validate();
  if (lstatSync(complete, { throwIfNoEntry: false })) validate(complete);
  let identity = existing;
  const syncParent = (): void => {
    const fd = openSync(dirname(journal), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const persist = (path: string): void => {
    prepareBackupParent(path);
    const fd = openSync(path, 'wx', 0o600);
    const created = fstatSync(fd);
    try {
      const data = Buffer.from(expected);
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(fd, data, offset, data.length - offset);
        if (written === 0) throw new Error('Cannot persist restore retry ownership');
        offset += written;
      }
      fsyncSync(fd);
    } catch (error) {
      // No target writes precede this initial receipt. Remove only this attempt's fresh inode.
      const current = lstatSync(path, { throwIfNoEntry: false });
      if (current?.dev === created.dev && current.ino === created.ino) rmSync(path);
      throw error;
    } finally {
      closeSync(fd);
    }
  };
  return {
    resume: Boolean(existing),
    begin() {
      if (existing) {
        validate();
        const current = lstatSync(journal);
        if (current.dev !== identity?.dev || current.ino !== identity?.ino)
          throw new Error('Restore retry ownership changed');
        const fd = openSync(journal, constants.O_RDONLY | constants.O_NOFOLLOW);
        try {
          const opened = fstatSync(fd);
          if (opened.dev !== identity?.dev || opened.ino !== identity?.ino)
            throw new Error('Restore retry ownership changed');
          fsyncSync(fd);
        } finally {
          closeSync(fd);
        }
        syncParent();
        validate();
        return;
      }
      persist(journal);
      identity = lstatSync(journal);
      syncParent();
      validate();
    },
    finish() {
      validate();
      const current = lstatSync(journal);
      if (current.dev !== identity?.dev || current.ino !== identity?.ino)
        throw new Error('Restore retry ownership changed');
      if (!lstatSync(complete, { throwIfNoEntry: false })) linkSync(journal, complete);
      validate(complete);
      // Make completion durable before unlinking progress: every error leaves a retry receipt.
      syncParent();
      if (journal === progressPath) {
        validate();
        const live = lstatSync(journal);
        if (live.dev !== identity?.dev || live.ino !== identity?.ino)
          throw new Error('Restore retry ownership changed');
        rmSync(journal);
        journal = complete;
        identity = lstatSync(complete);
        syncParent();
      }
    },
  };
}
