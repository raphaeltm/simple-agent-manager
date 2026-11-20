/** Private retry ownership for a restore that started from an empty bucket and state directory. */
import { createHash, randomBytes } from 'node:crypto';
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
import { basename, dirname, join, resolve } from 'node:path';

import { prepareBackupParent } from './backup-destination';
import { assertBackupOutside, type BoxContext } from './backup-lib';
import { assertOperatorExecution } from './operator-only';
import { assertPrivateFile, replacePrivateFile } from './secret-files';

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

interface TargetRecord {
  format: 'sam-restore-progress/2';
  source: string;
  bucket: string | undefined;
  state: string;
  environment: string;
  domain: string;
  endpoint: string;
  backup: string;
  snapshot: string;
  targetInstallation: string;
  phase: 'reserved' | 'started';
}
function targetScope(ctx: BoxContext, source: string) {
  return {
    format: 'sam-restore-progress/2' as const,
    source,
    bucket: ctx.box.CELLD_BUCKET,
    state: resolve(ctx.stateDir),
    environment: resolve(ctx.envFile),
    domain: ctx.box.SAM_DOMAIN ?? '',
    endpoint: ctx.box.S3_ENDPOINT ?? '',
  };
}
function journalPaths(ctx: BoxContext): { progress: string; complete: string } {
  return {
    progress: `${resolve(ctx.stateDir)}.restore-progress.json`,
    complete: `${resolve(ctx.stateDir)}.restore-complete.json`,
  };
}
function readTarget(ctx: BoxContext, source: string, path: string): TargetRecord {
  try {
    const stat = lstatSync(path);
    if (!stat.isFile() || stat.isSymbolicLink()) throw new Error('Invalid journal');
    assertPrivateFile(path);
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('Invalid journal');
    const value = raw as Partial<TargetRecord>;
    const scope = targetScope(ctx, source);
    if (
      Object.entries(scope).some(
        ([key, expected]) => value[key as keyof TargetRecord] !== expected
      ) ||
      typeof value.backup !== 'string' ||
      resolve(value.backup) !== value.backup ||
      typeof value.snapshot !== 'string' ||
      !/^[a-f0-9]{64}$/.test(value.snapshot) ||
      typeof value.targetInstallation !== 'string' ||
      !/^[a-f0-9]{32}$/.test(value.targetInstallation) ||
      value.targetInstallation === source ||
      !['reserved', 'started'].includes(value.phase ?? '')
    )
      throw new Error('Invalid journal');
    return value as TargetRecord;
  } catch {
    throw new Error(
      'Cannot verify restore retry ownership or target identity; preserve the target and its receipts for inspection'
    );
  }
}
/** Read a reservation already made by authenticated print-project/restore, never derive a clone ID. */
export function readRestoredInstallationId(ctx: BoxContext, source: string): string {
  assertOperatorExecution();
  const paths = journalPaths(ctx);
  const path = lstatSync(paths.progress, { throwIfNoEntry: false })
    ? paths.progress
    : paths.complete;
  return readTarget(ctx, source, path).targetInstallation;
}
export interface RestoreProgress {
  readonly resume: boolean;
  readonly installationId: string;
  reserve(): void;
  begin(): void;
  finish(): void;
}
export function restoreProgress(ctx: BoxContext, backup: string, source = ''): RestoreProgress {
  assertOperatorExecution();
  if (!/^[a-f0-9]{32}$/.test(source)) throw new Error('Invalid backup installation identity');
  const paths = journalPaths(ctx);
  const progressPath = paths.progress,
    complete = paths.complete;
  let journal =
    lstatSync(progressPath, { throwIfNoEntry: false }) ||
    !lstatSync(complete, { throwIfNoEntry: false })
      ? progressPath
      : complete;
  assertBackupOutside(ctx, progressPath);
  assertBackupOutside(ctx, complete);
  let identity = lstatSync(journal, { throwIfNoEntry: false });
  const expectedScope = {
    ...targetScope(ctx, source),
    backup: resolve(backup),
    snapshot: digest(join(backup, '.sam-backup-manifest')),
  };
  let record: TargetRecord = identity
    ? readTarget(ctx, source, journal)
    : { ...expectedScope, targetInstallation: randomBytes(16).toString('hex'), phase: 'reserved' };
  if (record.targetInstallation === source)
    throw new Error('Restore installation identity collision');
  const validate = (path = journal): void => {
    const current = readTarget(ctx, source, path);
    if (
      JSON.stringify(current) !== JSON.stringify(record) ||
      Object.entries(expectedScope).some(
        ([key, value]) => current[key as keyof TargetRecord] !== value
      )
    )
      throw new Error(
        'Cannot verify restore retry ownership; preserve the partial target for inspection'
      );
  };
  if (identity) validate();
  if (lstatSync(complete, { throwIfNoEntry: false })) {
    validate(complete);
    if (record.phase !== 'started')
      throw new Error('Invalid completed restore identity reservation');
  }
  const syncParent = (): void => {
    const fd = openSync(dirname(journal), 'r');
    try {
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
  };
  const verifyIdentity = (): void => {
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
  };
  const persist = (): void => {
    prepareBackupParent(journal);
    const temp = join(
      dirname(journal),
      `.${basename(journal)}.${randomBytes(16).toString('hex')}.tmp`
    );
    const fd = openSync(temp, 'wx', 0o600);
    try {
      const data = Buffer.from(JSON.stringify(record));
      let offset = 0;
      while (offset < data.length) {
        const written = writeSync(fd, data, offset, data.length - offset);
        if (!written) throw new Error('Cannot persist restore retry ownership');
        offset += written;
      }
      fsyncSync(fd);
      // No replace: concurrent reservations cannot overwrite the winning random identity.
      linkSync(temp, journal);
    } finally {
      closeSync(fd);
      rmSync(temp, { force: true });
    }
    identity = lstatSync(journal);
    syncParent();
    validate();
  };
  return {
    get resume() {
      return Boolean(identity && record.phase === 'started');
    },
    get installationId() {
      return record.targetInstallation;
    },
    reserve() {
      if (identity) verifyIdentity();
      else {
        try {
          persist();
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
          // Read and durably reuse the winner rather than replacing its nonce.
          record = readTarget(ctx, source, journal);
          identity = lstatSync(journal);
          verifyIdentity();
        }
      }
    },
    begin() {
      if (identity) {
        verifyIdentity();
        if (record.phase === 'reserved') {
          record = { ...record, phase: 'started' };
          replacePrivateFile(journal, JSON.stringify(record));
          identity = lstatSync(journal);
          validate();
        }
      } else {
        record = { ...record, phase: 'started' };
        persist();
      }
    },
    finish() {
      if (record.phase !== 'started') throw new Error('Restore has not started');
      verifyIdentity();
      if (!lstatSync(complete, { throwIfNoEntry: false })) linkSync(journal, complete);
      validate(complete);
      syncParent();
      if (journal === progressPath) {
        verifyIdentity();
        rmSync(journal);
        journal = complete;
        identity = lstatSync(complete);
        syncParent();
      }
    },
  };
}
