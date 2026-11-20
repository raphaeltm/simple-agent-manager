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
import { join } from 'node:path';

import { BUNDLE_ID, type SealedBundle } from './bundle.ts';

/** The state-directory location, relative to the state dir (platform-keys.ts reads it too). */
export const LOCAL_BUNDLE_SUBDIR = join('key-agent', 'bundles');

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

function localBundleStore(dir: string): BundleStore {
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
      mkdirSync(dir, { recursive: true, mode: 0o700 });
      const target = pathOf(bundle.bundleId);
      if (lstatSync(target, { throwIfNoEntry: false })) {
        throw new Error(`bundle ${bundle.bundleId} already exists in ${dir}`);
      }
      // Temp file in the same directory, fsynced, then renamed: a crash leaves the old set or
      // the new bundle whole, never a torn file the agent would refuse.
      const temp = join(dir, `.${bundle.bundleId}.${process.pid}.tmp`);
      rmSync(temp, { force: true });
      const fd = openSync(temp, 'wx', 0o600);
      try {
        writeSync(fd, `${JSON.stringify(bundle, null, 2)}\n`);
        fsyncSync(fd);
      } finally {
        closeSync(fd);
      }
      renameSync(temp, target);
      // The rename is durable only once the directory is: until then a power loss can drop the
      // new name, after the deploy published this id and migrate removed the plaintext files.
      syncDirectory(dir);
    },
    async remove(bundleId) {
      rmSync(pathOf(bundleId), { force: true });
      syncDirectory(dir);
    },
  };
}
