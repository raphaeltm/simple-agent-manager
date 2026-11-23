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
  existsSync,
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

/**
 * An exclusive lock file holding the owner's pid (O_EXCL create). A lock whose pid is no longer
 * running is broken (a process that died while holding it), as is one left with no pid for
 * EMPTY_LOCK_STALE_MS; a live holder is waited for, up to `waitMs`. Same host and pid namespace
 * only: the head, like the bundles, belongs to one box. Known limits (all need a crash first): a
 * dead holder's pid reused by an unrelated process keeps the lock until it is removed by hand
 * (the error says how), and two waiters breaking the same stale lock at once can both proceed.
 */
export async function withLockFile<T>(
  lockPath: string,
  fn: () => Promise<T>,
  waitMs = DEFAULT_HEAD_LOCK_WAIT_MS
): Promise<T> {
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
      try {
        return await fn();
      } finally {
        rmSync(lockPath, { force: true });
      }
    }
    let holder = Number.NaN;
    let ageMs = 0;
    try {
      const text = readFileSync(lockPath, 'utf8').trim();
      holder = /^\d+$/.test(text) ? Number(text) : Number.NaN;
      ageMs = Date.now() - lstatSync(lockPath).mtimeMs;
    } catch {
      continue; // released between our attempt and this read
    }
    const valid = Number.isInteger(holder) && holder > 0;
    if ((valid && !pidAlive(holder)) || (!valid && ageMs > EMPTY_LOCK_STALE_MS)) {
      rmSync(lockPath, { force: true });
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
