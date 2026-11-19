/** Private retry ownership for a restore that started from an empty bucket and state directory. */
import { createHash } from 'node:crypto';
import {
  closeSync,
  constants,
  fstatSync,
  fsyncSync,
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

function assertOwned(stat: Stats): void {
  if (process.getuid !== undefined && stat.uid !== process.getuid())
    throw new Error('Restore retry contains foreign-owned data');
}
/** Existing partial output must be an exact subset of the authenticated snapshot. Never delete it. */
export function assertRestoreSubset(current: string, expected: string): void {
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
    if (found.isDirectory() && original.isDirectory()) assertRestoreSubset(path, source);
    else if (
      !found.isFile() ||
      !original.isFile() ||
      found.nlink !== 1 ||
      original.nlink !== 1 ||
      digest(path) !== digest(source)
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
  const journal = `${resolve(ctx.stateDir)}.restore-progress.json`;
  assertBackupOutside(ctx, journal);
  const expected = JSON.stringify({
    format: 'sam-restore-progress/1',
    bucket: ctx.box.CELLD_BUCKET,
    state: resolve(ctx.stateDir),
    backup: resolve(backup),
    snapshot: digest(join(backup, '.sam-backup-manifest')),
  });
  const existing = lstatSync(journal, { throwIfNoEntry: false });
  const validate = (): void => {
    try {
      if (lstatSync(journal).isSymbolicLink()) throw new Error('Invalid journal');
      assertPrivateFile(journal);
      if (readFileSync(journal, 'utf8') !== expected) throw new Error('Different restore');
    } catch {
      throw new Error(
        'Cannot verify restore retry ownership; preserve the partial target for inspection'
      );
    }
  };
  if (existing) validate();
  let identity = existing;
  const syncParent = (): void => {
    const fd = openSync(dirname(journal), 'r');
    try {
      fsyncSync(fd);
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
        return;
      }
      prepareBackupParent(journal);
      const fd = openSync(journal, 'wx', 0o600);
      try {
        const data = Buffer.from(expected);
        let offset = 0;
        while (offset < data.length) {
          const written = writeSync(fd, data, offset, data.length - offset);
          if (written === 0) throw new Error('Cannot persist restore retry ownership');
          offset += written;
        }
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      identity = lstatSync(journal);
      syncParent();
      validate();
    },
    finish() {
      validate();
      const current = lstatSync(journal);
      if (current.dev !== identity?.dev || current.ino !== identity?.ino)
        throw new Error('Restore retry ownership changed');
      rmSync(journal);
      syncParent();
    },
  };
}
