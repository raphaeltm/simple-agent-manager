/**
 * Where sealed bundles live: the one seam every reader and writer goes through. The deploy
 * (scripts/selfhost/key-service.ts) seals and prunes through it, the agent (server.ts) reads
 * through it, and the status, switch, preflight and plaintext tools list through it.
 *
 * Today the only location is the box's state directory (`<state>/key-agent/bundles/`). A bundle
 * is ciphertext that only the key service can open, so a later location shared by several boxes
 * (the fleet bucket, for a replaceable box) is one new `BundleStore` and one new branch in
 * `openBundleStore`; no caller changes. The interface is asynchronous for that reason.
 */
import {
  closeSync,
  constants,
  existsSync,
  fstatSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { BUNDLE_ID, type SealedBundle } from './bundle.ts';

/** The state-directory location, relative to the state dir (platform-keys.ts reads it too). */
export const LOCAL_BUNDLE_SUBDIR = join('key-agent', 'bundles');
/** The head beside the bundles (scripts/selfhost/bundle-head.ts), relative to the state dir. */
export const LOCAL_HEAD_FILE = join('key-agent', 'head.json');

export interface BundleStore {
  /** Where the bundles are, for messages. Never a credential. */
  readonly location: string;
  /** The ids of every bundle present, in no particular order. */
  listIds(): Promise<string[]>;
  /** A bundle's text, or null when there is no such bundle. */
  read(bundleId: string): Promise<string | null>;
  /** Stores a new bundle; refuses to replace an existing one (ids are never reused). */
  write(bundle: SealedBundle): Promise<void>;
  remove(bundleId: string): Promise<void>;
  /**
   * The head (scripts/selfhost/bundle-head.ts): which bundle is current. Its text, or null when
   * there is none. Never parsed or trusted here; the deploy verifies it under the key.
   */
  readHead(): Promise<string | null>;
  /** Replaces the head whole (atomic): a crash leaves the old head or the new one. */
  writeHead(text: string): Promise<void>;
  removeHead(): Promise<void>;
  /**
   * Runs `fn` holding this state's head lock: one read-compare-write of the head at a time, across
   * processes (a deploy and a rotation or switch on the same box). See withHeadLock below.
   */
  withHeadLock<T>(fn: () => Promise<T>): Promise<T>;
}

/** How long to wait for another process's head lock before giving up. */
export const DEFAULT_HEAD_LOCK_WAIT_MS = 30_000;
/** A lock file with no pid in it this long after it was made is a crash between create and write. */
const EMPTY_LOCK_STALE_MS = 5_000;
const HEAD_LOCK_POLL_MS = 50;

function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive but another user's process; only ESRCH means gone.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

/** The lock file's holder pid (NaN when none is recorded), age and inode; null when it is gone. */
function readLock(
  lockPath: string
): { holder: number; holders: number[]; ageMs: number; ino: number } | null {
  try {
    const before = lstatSync(lockPath);
    const text = readFileSync(lockPath, 'utf8').trim();
    // The same file throughout: a lock replaced between the stat and the read is read again.
    if (lstatSync(lockPath).ino !== before.ino) return null;
    // The owner's pid first, then any process that joined it (joinLockFile).
    const holders = text
      .split(/\s+/)
      .filter((field) => /^\d+$/.test(field))
      .map(Number)
      .filter((pid) => pid > 0);
    return {
      holder: holders[0] ?? Number.NaN,
      holders,
      ageMs: Date.now() - before.mtimeMs,
      ino: before.ino,
    };
  } catch {
    return null;
  }
}

/**
 * Removes a stale lock, but only the very file judged stale (same inode) and only while holding a
 * short breaker lock: two waiters that both saw the dead holder cannot both break it, because
 * the second, once it holds the breaker, finds a different file (the first one's new lock) and
 * leaves it. A breaker left by a crash (it is held for one stat and one unlink) expires.
 */
export function breakStaleLock(lockPath: string, staleIno: number): void {
  const breaker = `${lockPath}.break`;
  let fd: number;
  try {
    fd = openSync(breaker, 'wx', 0o600);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    const age = Date.now() - (lstatSync(breaker, { throwIfNoEntry: false })?.mtimeMs ?? Date.now());
    if (age > EMPTY_LOCK_STALE_MS) rmSync(breaker, { force: true });
    return;
  }
  closeSync(fd);
  try {
    // Judged again under the breaker: a child may have joined (appended a live pid to this same
    // file) since the waiter read it.
    const now = readLock(lockPath);
    if (now?.ino === staleIno && !now.holders.some(pidAlive)) {
      rmSync(lockPath, { force: true });
    }
  } finally {
    rmSync(breaker, { force: true });
  }
}

/**
 * An exclusive lock file holding the owner's pid (O_EXCL create). A lock whose pid is no longer
 * running is broken (a process that died while holding it), as is one left with no pid for
 * EMPTY_LOCK_STALE_MS; a live holder is waited for, up to `waitMs`. Same host and pid namespace
 * only: the head, like the bundles, belongs to one box. A stale lock is broken by breakStaleLock,
 * one waiter at a time. Known limit (needs a crash first): a dead holder's pid reused by an
 * unrelated process keeps the lock until it is removed by hand (the error says how).
 */
export async function acquireLockFile(
  lockPath: string,
  waitMs = DEFAULT_HEAD_LOCK_WAIT_MS
): Promise<() => void> {
  const deadline = Date.now() + waitMs;
  mkdirSync(dirname(lockPath), { recursive: true, mode: 0o700 });
  for (;;) {
    let fd: number | undefined;
    try {
      fd = openSync(lockPath, 'wx', 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    if (fd !== undefined) {
      try {
        writeSync(fd, `${process.pid}\n`);
      } finally {
        closeSync(fd);
      }
      return () => rmSync(lockPath, { force: true });
    }
    const seen = readLock(lockPath);
    if (!seen) continue; // released between our attempt and this read
    const valid = seen.holders.length > 0;
    const holder = seen.holder;
    // Stale only once every process in it is gone: a child that joined its parent's lock keeps
    // it held after the parent dies, until the child ends too.
    if ((valid && !seen.holders.some(pidAlive)) || (!valid && seen.ageMs > EMPTY_LOCK_STALE_MS)) {
      breakStaleLock(lockPath, seen.ino);
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(
        `${lockPath} is held by process ${valid ? holder : '(none recorded)'}: another deploy, ` +
          'rotation or switch is changing the sealed secrets. Wait for it, then run again. If ' +
          'none is running, remove that file.'
      );
    }
    await new Promise((resolve) => setTimeout(resolve, HEAD_LOCK_POLL_MS));
  }
}

/**
 * Adds this process to a lock that `owner` holds (a child operation run by the owner), so the lock
 * stays held while this process runs even if the owner dies first. Appends through a descriptor,
 * then checks that the path still is that same file and still names `owner` first: false (and
 * nothing joined) when the owner's lock was broken and replaced meanwhile. Never removes the file.
 */
export function joinLockFile(
  lockPath: string,
  owner: string,
  /** Test seam: runs between the append and the checks (where a replacement can land). */
  afterAppend: () => void = () => undefined
): boolean {
  let fd: number;
  try {
    // No O_CREAT: joining never creates a lock (it would name only this process).
    fd = openSync(lockPath, constants.O_WRONLY | constants.O_APPEND);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false;
    throw error;
  }
  try {
    writeSync(fd, `${process.pid}\n`);
    afterAppend();
    const joined = fstatSync(fd).ino;
    if (lstatSync(lockPath, { throwIfNoEntry: false })?.ino !== joined) return false;
    // The owner must still be running: a dead owner's lock is stale, and is taken, not joined.
    const first = readFileSync(lockPath, 'utf8').trim().split(/\s+/)[0];
    return first === owner && pidAlive(Number(owner));
  } finally {
    closeSync(fd);
  }
}

/** Runs `fn` holding the lock file (acquireLockFile), released however `fn` ends. */
export async function withLockFile<T>(
  lockPath: string,
  fn: () => Promise<T>,
  waitMs = DEFAULT_HEAD_LOCK_WAIT_MS
): Promise<T> {
  const release = await acquireLockFile(lockPath, waitMs);
  try {
    return await fn();
  } finally {
    release();
  }
}

export interface BundleStoreConfig {
  /** `<state>/key-agent/bundles` on the deploying host, or its mount inside the agent. */
  dir: string;
}

/** fsync a directory, so names created, renamed or removed in it survive a power loss. */
function syncDirectory(dir: string): void {
  const fd = openSync(dir, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** The one place a bundle location is chosen. */
export function openBundleStore(config: BundleStoreConfig): BundleStore {
  return localBundleStore(config.dir);
}

function assertId(bundleId: string): void {
  if (!BUNDLE_ID.test(bundleId)) throw new Error('not a bundle id');
}

/** Writes `text` to `target` through an fsynced temp file and a rename, then syncs the directory. */
function writeAtomically(target: string, text: string, exclusive: boolean): void {
  const dir = dirname(target);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (exclusive && lstatSync(target, { throwIfNoEntry: false })) {
    throw new Error(`${target} already exists`);
  }
  const temp = join(dir, `.${target.slice(dir.length + 1)}.${process.pid}.tmp`);
  rmSync(temp, { force: true });
  const fd = openSync(temp, 'wx', 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(temp, target);
  // The rename is durable only once the directory is: until then a power loss can drop the
  // new name, after the deploy published this id and migrate removed the plaintext files.
  syncDirectory(dir);
}

function localBundleStore(dir: string): BundleStore {
  // Beside the bundles directory (LOCAL_HEAD_FILE), not in it: the agent never reads the head.
  const headPath = join(dirname(dir), 'head.json');
  const pathOf = (bundleId: string): string => {
    assertId(bundleId);
    return join(dir, `${bundleId}.json`);
  };
  return {
    location: dir,
    async listIds() {
      if (!existsSync(dir)) return [];
      return readdirSync(dir)
        .filter((name) => /^[0-9a-f]{32}\.json$/.test(name))
        .map((name) => name.slice(0, -'.json'.length));
    },
    async read(bundleId) {
      try {
        return readFileSync(pathOf(bundleId), 'utf8');
      } catch (error) {
        // Only a missing file is "no such bundle". Any other failure (permissions, I/O) is an
        // unreadable bundle and must surface, or a deploy could fall back to an older one.
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async write(bundle) {
      const target = pathOf(bundle.bundleId);
      if (lstatSync(target, { throwIfNoEntry: false })) {
        throw new Error(`bundle ${bundle.bundleId} already exists in ${dir}`);
      }
      // Temp file in the same directory, fsynced, then renamed: a crash leaves the old set or
      // the new bundle whole, never a torn file the agent would refuse.
      writeAtomically(target, `${JSON.stringify(bundle, null, 2)}\n`, true);
    },
    async remove(bundleId) {
      rmSync(pathOf(bundleId), { force: true });
      syncDirectory(dir);
    },
    async readHead() {
      try {
        return readFileSync(headPath, 'utf8');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
        throw error;
      }
    },
    async writeHead(text) {
      writeAtomically(headPath, text, false);
    },
    async removeHead() {
      if (!existsSync(headPath)) return;
      rmSync(headPath, { force: true });
      syncDirectory(dirname(headPath));
    },
    withHeadLock: (fn) => withLockFile(`${headPath}.lock`, fn),
  };
}
