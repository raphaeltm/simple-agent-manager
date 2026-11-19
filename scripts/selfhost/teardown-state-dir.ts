/**
 * Teardown items for the box's state directory (teardown-box.ts lists them with the others):
 * the key file, a legacy platform-keys.json, and everything else in `.state` except the record.
 * Emptying it survives read-only trees (Go's module cache) and an entry it cannot remove, so the
 * secrets always go first and the summary names what is left (box round R12).
 */
import {
  chmodSync,
  existsSync,
  lstatSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
} from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import { readRecord } from '../../deploy/selfhost/created-resources.mjs';
import { STATE_CACHE_EXCLUDES } from './backup-lib';
import { RECORD_FILE } from './install-record';
import type { TeardownContext } from './teardown-box';
import { both, type Item, STEPS } from './teardown-model';

const KEY_FILE = join('key-agent', 'kek');
const LEGACY_KEYS = 'platform-keys.json';

export function stateItems(ctx: TeardownContext): Item[] {
  if (!existsSync(ctx.stateDir)) return [];
  const items: Item[] = [];
  const keyFile = join(ctx.stateDir, KEY_FILE);
  const legacyKeys = join(ctx.stateDir, LEGACY_KEYS);
  const keepKey = !ctx.options.destroyKey;
  const keyDecision = {
    'keep-data': { act: 'keep' as const, why: 'keep my data keeps the key' },
    'remove-everything': ctx.options.destroyKey
      ? { act: 'remove' as const }
      : { act: 'keep' as const, why: 'pass --destroy-key to delete it' },
  };
  if (existsSync(keyFile)) {
    items.push({
      id: 'box:key-file',
      place: 'on the box',
      what: `key file ${keyFile} (opens the sealed bundles)`,
      provenance: 'discovered, not recorded',
      how: `rm ${keyFile}`,
      step: STEPS.state,
      plan: keyDecision,
      forGood:
        'every sealed bundle and every backup of this box sealed with this key can never be opened again, unless you keep a copy',
      runKey: 'state',
      goneDespiteGroupFailure: () => isGone(keyFile),
      record: { cloud: 'box', kind: 'key-file', name: keyFile, createdBy: 'deploy' },
    });
  }
  if (existsSync(legacyKeys)) {
    items.push({
      id: 'box:platform-keys',
      place: 'on the box',
      what: `${legacyKeys} (plaintext platform keys of a legacy-plaintext box)`,
      provenance: 'discovered, not recorded',
      how: `rm ${legacyKeys}`,
      step: STEPS.state,
      plan: keyDecision,
      forGood: 'the box copy of the platform keys; backups hold their own copy',
      runKey: 'state',
      goneDespiteGroupFailure: () => isGone(legacyKeys),
      record: {
        cloud: 'box',
        kind: 'platform-keys',
        name: legacyKeys,
        createdBy: 'deploy',
        attributes: { installation: ctx.installationId ?? '', environment: 'selfhost' },
      },
    });
  }
  const state = ctx.record.find((r) => r.cloud === 'box' && r.kind === 'state-dir');
  items.push({
    id: 'box:state',
    place: 'on the box',
    what: `${ctx.stateDir} (sealed bundles, generated config, deploy project, celld binary, caches, secrets.env)`,
    provenance: state ? 'recorded' : 'discovered, not recorded',
    how: `rm -r everything in ${ctx.stateDir} except ${RECORD_FILE} and a key that is kept`,
    step: STEPS.state,
    plan: {
      'keep-data': { act: 'keep', why: 'keep my data keeps the bundles and state' },
      'remove-everything': { act: 'remove' },
    },
    removedAt: state?.removedAt,
    runKey: 'state',
    run: () => clearState(ctx, keepKey),
    record: [
      { cloud: 'box', kind: 'state-dir', name: ctx.stateDir, createdBy: 'deploy' },
      // The install itself is gone with its state; the id stays readable for a resumed run.
      ...ctx.record
        .filter((r) => r.cloud === 'box' && r.kind === 'installation')
        .map((r) => ({ cloud: 'box', kind: 'installation', name: r.name })),
    ],
  });
  items.push({
    id: 'box:record',
    place: 'on the box',
    what: `${ctx.recordFile} (this record: teardown's receipt)`,
    provenance: 'recorded',
    how: `rm ${ctx.recordFile} by hand once you no longer need it`,
    step: STEPS.state,
    plan: both({ act: 'keep', why: 'the receipt a second run resumes from' }),
  });
  return items;
}

/**
 * True only when the path provably does not exist (ENOENT). existsSync also answers false for a
 * path it may not look at (EACCES) and for a dangling link, which must not read as removed.
 */
function isGone(path: string): boolean {
  try {
    lstatSync(path);
    return false;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === 'ENOENT';
  }
}

/** Everything in .state except the record, and the keys when they are kept. */
function clearState(ctx: TeardownContext, keepKey: boolean): void {
  assertStateDir(ctx);
  const left = clearStateEntries(ctx.stateDir, keepKey, ctx.removeTree);
  if (left.length > 0) throw new Error(describeLeftovers(ctx.stateDir, left));
}

export interface Leftover {
  path: string;
  /** A rebuildable cache (STATE_CACHE_EXCLUDES): holds no secret. */
  cache: boolean;
  error: string;
}

/**
 * Removes every entry of the state directory except the record (and the key, when kept), and
 * returns what could not be removed. Caches go last and a failure does not stop the others, so
 * an unremovable build cache can never leave the sealed bundles or key material behind
 * (box round R12: the Go module cache's read-only directories stopped the whole removal).
 */
export function clearStateEntries(
  stateDir: string,
  keepKey: boolean,
  remove: (path: string) => void = removeTree
): Leftover[] {
  const isCache = (entry: string) => STATE_CACHE_EXCLUDES.includes(entry);
  const entries = readdirSync(stateDir)
    .filter((entry) => entry !== RECORD_FILE && !(keepKey && entry === LEGACY_KEYS))
    .sort((a, b) => Number(isCache(a)) - Number(isCache(b)) || a.localeCompare(b));
  const left: Leftover[] = [];
  const attempt = (path: string, cache: boolean) => {
    try {
      remove(path);
    } catch (error) {
      left.push({ path, cache, error: error instanceof Error ? error.message : String(error) });
    }
  };
  for (const entry of entries) {
    const path = join(stateDir, entry);
    if (entry === 'key-agent' && keepKey) {
      // Not a plain directory (a link): left whole, since the kept key is behind it.
      if (!lstatSync(path).isDirectory()) continue;
      for (const inner of readdirSync(path)) {
        if (inner !== basename(KEY_FILE)) attempt(join(path, inner), false);
      }
      continue;
    }
    attempt(path, isCache(entry));
  }
  return left;
}

function describeLeftovers(stateDir: string, left: Leftover[]): string {
  const secretsLeft = left.some((l) => !l.cache);
  const lines = left.map(
    (l) => `${l.path}${l.cache ? ' (a build cache, no secrets)' : ''}: ${l.error}`
  );
  return [
    `could not remove ${left.length} of the entries in ${stateDir}: ${lines.join('; ')}.`,
    secretsLeft
      ? 'Some of what is left is not a cache and may hold sealed bundles or keys.'
      : 'Everything else in it is gone, including the sealed bundles and key material.',
    `Remove what is left by hand: chmod -R u+w <path> && rm -r <path>, then run teardown again.`,
  ].join(' ');
}

/**
 * `rm -r` that also removes trees with read-only directories. Go makes every module-cache
 * directory 0555 (`go-cache/mod`), and deleting an entry needs write permission on its parent.
 * Directories are made owner-writable first; symbolic links are never followed.
 */
export function removeTree(path: string): void {
  makeDirsWritable(path);
  rmSync(path, { recursive: true, force: true });
}

function makeDirsWritable(path: string): void {
  const stat = lstatSync(path, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  if ((stat.mode & 0o700) !== 0o700) {
    try {
      chmodSync(path, (stat.mode & 0o7777) | 0o700);
    } catch {
      // Not ours to change (another owner): rmSync reports what it cannot remove.
    }
  }
  for (const entry of readdirSync(path)) makeDirsWritable(join(path, entry));
}

/** True for `/`, the home directory, and any directory that contains the checkout. */
export function isProtectedDir(path: string, selfhostDir: string): boolean {
  const target = resolve(path);
  if (target === '/' || target === resolve(homedir())) return true;
  const rel = relative(target, resolve(selfhostDir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The state directory comes from .env or --state-dir, so prove it is SAM's before emptying it
 * Require its exact active creation receipt, live directory identity, and matching installation
 * and platform identity. Protected paths and symlink roots are always refused.
 */
function assertStateDir(ctx: TeardownContext): void {
  // Also through symbolic links: a .state that links to the home directory is still refused.
  if (
    isProtectedDir(ctx.stateDir, ctx.selfhostDir) ||
    isProtectedDir(realpathSync(ctx.stateDir), ctx.selfhostDir)
  ) {
    throw new Error(`refused: ${ctx.stateDir} is /, your home or contains the checkout`);
  }
  if (
    realpathSync(ctx.stateDir) !== resolve(ctx.stateDir) ||
    lstatSync(ctx.stateDir).isSymbolicLink()
  )
    throw new Error('Refused: state path uses symlinks');
  const record = readRecord(ctx.recordFile).resources;
  const states = record.filter(
    (r) =>
      r.cloud === 'box' &&
      r.kind === 'state-dir' &&
      r.name === resolve(ctx.stateDir) &&
      r.action === 'created' &&
      !r.removedAt
  );
  const installs = record.filter(
    (r) => r.cloud === 'box' && r.kind === 'installation' && r.action === 'created' && !r.removedAt
  );
  const stat = lstatSync(ctx.stateDir);
  if (
    !ctx.installationId ||
    installs.length !== 1 ||
    installs[0]?.name !== ctx.installationId ||
    installs[0]?.attributes?.environment !== 'selfhost' ||
    installs[0]?.attributes?.domain !== ctx.domain ||
    states.length !== 1 ||
    states[0]?.attributes?.installation !== ctx.installationId ||
    states[0]?.attributes?.environment !== 'selfhost' ||
    states[0]?.attributes?.device !== String(stat.dev) ||
    states[0]?.attributes?.inode !== String(stat.ino)
  )
    throw new Error('Refused: missing exact active installation state creation receipt');
  const keys = join(ctx.stateDir, LEGACY_KEYS);
  if (existsSync(keys)) {
    let identity: unknown;
    try {
      const parsed: unknown = JSON.parse(readFileSync(keys, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) throw new Error();
      identity = (parsed as { SAM_INSTALLATION_ID?: unknown }).SAM_INSTALLATION_ID;
    } catch {
      throw new Error('Refused: unreadable installation identity');
    }
    if (identity !== ctx.installationId)
      throw new Error('Refused: platform identity disagrees with installation receipt');
  } else if (
    !record.some(
      (r) =>
        r.cloud === 'box' &&
        r.kind === 'platform-keys' &&
        r.name === keys &&
        r.removedAt &&
        r.attributes?.installation === ctx.installationId &&
        r.attributes?.environment === 'selfhost'
    )
  ) {
    throw new Error(
      'Refused: missing platform identity and no receipt that this teardown removed it'
    );
  }
}
