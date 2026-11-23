/**
 * A replaceable box (README "Replaceable box"): with `SAM_REPLACEABLE_BOX=true` a dead box can be
 * rebuilt on a new VM from its fleet bucket and its off-box key alone (rebuild.ts).
 *
 * celld already keeps its data (D1, Durable Objects, KV, R2, hosted git) in the bucket. What only
 * the box's disk held is the sealed bundles (the platform keys that data is encrypted under) and
 * the install record's cloud entries (what teardown must remove). Both go to `sam-box/` under
 * `CELLD_BUCKET`, as ciphertext sealed by the key service:
 *
 *   sam-box/bundles/<id>.json   every sealed bundle, written and pruned with the local copy
 *   sam-box/head.json           which bundle is current (bundle-head.ts), sealed, written with
 *                               the local head
 *   sam-box/ledger.json         the install record's cloud entries, sealed (no secret, but
 *                               teardown acts on them, so a bucket writer must not forge them)
 *
 * The key agent keeps reading its local copy, so it gains no bucket credential. The mode needs a
 * key held off the box: with the `file` provider the key would die with the box, and copying it
 * into the bucket would make the bucket alone enough to open every secret. So `file`,
 * `legacy-plaintext` and the bundled store (the bucket lives on the box) are refused.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import type { CreatedResource } from '../../deploy/selfhost/created-resources.mjs';
import {
  BUNDLE_ID,
  openBundle,
  parseBundle,
  type SealedBundle,
  sealSecrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import {
  type BundleStore,
  LOCAL_BUNDLE_SUBDIR,
  openBundleStore,
} from '../../deploy/selfhost/key-agent/bundle-store.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { runCommand } from './backup-cli';
import type { BoxContext, Runner } from './backup-lib';
import { deleteObjects, listObjects, readObject, writeObject } from './bucket-objects';
import { type BundleHead, headHint, openHead } from './bundle-head';
import { readInstallRecord, usesBundledStore } from './install-record';

type Box = Readonly<Record<string, string | undefined>>;

export const BOX_MIRROR_PREFIX = 'sam-box/';
const BUNDLES_PREFIX = `${BOX_MIRROR_PREFIX}bundles/`;
export const LEDGER_KEY = `${BOX_MIRROR_PREFIX}ledger.json`;
/** The bucket copy of the box's bundle head (bundle-head.ts). */
export const HEAD_KEY = `${BOX_MIRROR_PREFIX}head.json`;
/** The one secret name a sealed ledger holds; a bundle holding it is not a Worker bundle. */
export const LEDGER_SECRET = 'SAM_BOX_LEDGER';
/**
 * Providers whose key is held off the box. An allowlist, so a provider added later is refused
 * here until someone decides where its key lives.
 */
export const OFF_BOX_PROVIDERS: readonly string[] = ['gcp-kms', 'aws-kms', 'azure-kv', 'transit'];

/**
 * Written by rebuild before it restores anything and removed once the record is complete, so a
 * rebuild that stopped part way is never deployed or sealed over: that would prune the bucket's
 * older bundles and replace its ledger with a partial one.
 */
export const REBUILD_MARKER = join('key-agent', 'rebuild-pending');

/** Refuses while a rebuild of this state directory has not finished. */
export function assertNoPendingRebuild(stateDir: string): void {
  if (existsSync(join(stateDir, REBUILD_MARKER))) {
    throw new Error(
      `a rebuild of ${stateDir} has not finished: run pnpm selfhost:rebuild again (it completes ` +
        'it) before deploying or sealing'
    );
  }
}

/** `SAM_REPLACEABLE_BOX` in `.env`: off unless set to true. */
export function replaceableBox(box: Box): boolean {
  const raw = (box.SAM_REPLACEABLE_BOX ?? '').trim().toLowerCase();
  if (raw === '' || raw === 'false' || raw === '0') return false;
  if (raw === 'true' || raw === '1') return true;
  throw new Error('SAM_REPLACEABLE_BOX must be true or false');
}

/** Refuses a replaceable box whose secrets or bucket would die with it. */
export function assertReplaceableSetup(box: Box, provider: string): void {
  if (!replaceableBox(box)) return;
  if (!OFF_BOX_PROVIDERS.includes(provider)) {
    throw new Error(
      `SAM_REPLACEABLE_BOX=true needs a key held off this box (${OFF_BOX_PROVIDERS.join(', ')}), ` +
        `not ${provider}: ${provider === 'file' ? 'the key file dies with the box, so its secrets could never be opened on a replacement' : 'every Worker secret would sit in plaintext in the bucket'}. ` +
        'Set up a cloud key (README "Cloud key, one-time setup"), or remove SAM_REPLACEABLE_BOX'
    );
  }
  if (usesBundledStore(box as Readonly<Record<string, string>>)) {
    throw new Error(
      'SAM_REPLACEABLE_BOX=true needs a fleet bucket off this box (gs:// or s3://), not the ' +
        'bundled store (profile local-store), whose data lives in a volume on this box'
    );
  }
}

/** Exactly the object operations the copy needs, keyed relative to `CELLD_BUCKET`. */
export interface BoxBucket {
  list(prefix: string): string[];
  read(key: string): string;
  write(key: string, text: string): void;
  remove(keys: readonly string[]): void;
}

/** The fleet bucket through the tools the box already uses (bucket-objects.ts). */
export function fleetBucket(box: Box, run: Runner = runCommand): BoxBucket {
  const uid = process.getuid?.();
  const gid = process.getgid?.();
  const ctx: BoxContext = {
    box: box as Readonly<Record<string, string>>,
    envFile: '',
    stateDir: '',
    composeFiles: [],
    run,
    now: () => Date.now(),
    log: () => undefined,
    user: uid !== undefined && gid !== undefined ? `${uid}:${gid}` : undefined,
  };
  return {
    list: (prefix) => listObjects(ctx, prefix).map((object) => object.key),
    read: (key) => readObject(ctx, key),
    write: (key, text) => writeObject(ctx, key, text),
    remove: (keys) => deleteObjects(ctx, keys),
  };
}

const bundleKey = (bundleId: string): string => `${BUNDLES_PREFIX}${bundleId}.json`;

/** Bundle ids under `sam-box/bundles/`; any other key there is ignored. */
export function bucketBundleIds(bucket: BoxBucket): string[] {
  return bucket.list(BUNDLES_PREFIX).flatMap((key) => {
    const id = key.slice(BUNDLES_PREFIX.length, -'.json'.length);
    return key.endsWith('.json') && BUNDLE_ID.test(id) ? [id] : [];
  });
}

/** A bucket bundle, parsed and checked against its name. Throws on anything else. */
export function readBucketBundle(bucket: BoxBucket, bundleId: string): SealedBundle {
  const bundle = parseBundle(bucket.read(bundleKey(bundleId)));
  if (bundle.bundleId !== bundleId)
    throw new Error(`bucket bundle ${bundleId}: id does not match its name`);
  return bundle;
}

/** A bucket bundle by id, naming the object when it cannot be read. */
function bucketBundleNamed(bucket: BoxBucket, bundleId: string): SealedBundle {
  try {
    return readBucketBundle(bucket, bundleId);
  } catch (error) {
    throw new Error(
      `${bundleKey(bundleId)} in the fleet bucket is not a readable sealed bundle ` +
        `(${error instanceof Error ? error.message : String(error)}); restore or remove it`
    );
  }
}

/** The bucket's head text, or null when it has none. */
export function bucketHead(bucket: BoxBucket): string | null {
  return bucket.list(BOX_MIRROR_PREFIX).includes(HEAD_KEY) ? bucket.read(HEAD_KEY) : null;
}

/**
 * Sealing must never start from a box that is behind its bucket: an empty box there is a
 * replacement that has not been rebuilt (sealing would make new platform keys and leave every
 * stored credential unreadable), and a box whose bucket records a later seal runs from an older
 * copy of its state (sealing would roll secrets back, and the next reconcile would prune the
 * genuine current bundle).
 *
 * "Later" is the heads' write sequence (bundle-head.ts), never a bundle's date: a clock that
 * moved backwards must not hide a later seal nor invent one. Every path that seals checks it with
 * `provider` first, which verifies both heads: the deploy (reconcileBundleMirror), rotation and
 * switch (assertNotBehindBucket). The mirrored store's own write check runs without a key and
 * reads the heads' hints: it is a backstop behind those verified checks and never the only one,
 * because a bucket writer could edit a hint's seq either way. Boxes and buckets from before the
 * head keep the date rule until the first deploy writes heads on both sides.
 */
export async function assertNotBehindBucket(
  box: Box,
  stateDir: string,
  provider: KeyProvider,
  bucket: BoxBucket = fleetBucket(box)
): Promise<void> {
  if (!replaceableBox(box)) return;
  await assertBoxNotBehindBucket(
    openBundleStore({ dir: join(stateDir, LOCAL_BUNDLE_SUBDIR) }),
    bucket,
    provider
  );
}

/** The heads' half of assertBoxNotBehindBucket: the bucket's head is no later than the box's. */
async function assertHeadNotBehind(
  local: BundleStore,
  localText: string | null,
  remoteText: string | null,
  provider: KeyProvider | undefined
): Promise<void> {
  const read = async (text: string, where: string) =>
    provider ? await openHead(text, provider, where) : (headHint(text, where) as BundleHead);
  if (localText === null) {
    throw new Error(
      `the fleet bucket has a bundle head (${HEAD_KEY}) but ${local.location} has none: this ` +
        'box runs from an older copy of its state. Refusing to seal over it; finish the ' +
        'rebuild (pnpm selfhost:rebuild) or remove the other box'
    );
  }
  const mine = await read(localText, 'the bundle head on this box');
  if (remoteText === null) return;
  const theirs = await read(remoteText, `${HEAD_KEY} in the fleet bucket`);
  if (theirs.installationId !== mine.installationId) {
    throw new Error(
      `${HEAD_KEY} in the fleet bucket belongs to installation ${theirs.installationId}, not ` +
        `this box's ${mine.installationId}: one bucket (or CELLD_BUCKET prefix) per installation`
    );
  }
  if (theirs.seq > mine.seq || (theirs.seq === mine.seq && theirs.bundleId !== mine.bundleId)) {
    throw new Error(
      `the fleet bucket's head names bundle ${theirs.bundleId} (write ${theirs.seq}), a later ` +
        `seal than this box's ${mine.bundleId} (write ${mine.seq}): another box sealed it, or ` +
        'this box runs from an older copy of its state. Refusing to seal over it; finish the ' +
        'rebuild (pnpm selfhost:rebuild) or remove the other box'
    );
  }
}

async function assertBoxNotBehindBucket(
  local: BundleStore,
  bucket: BoxBucket,
  provider?: KeyProvider
): Promise<void> {
  const localIds = await local.listIds();
  const onlyRemote = bucketBundleIds(bucket).filter((id) => !localIds.includes(id));
  if (onlyRemote.length > 0 && localIds.length === 0) {
    throw new Error(
      `the fleet bucket holds ${onlyRemote.length} sealed bundle(s) but ${local.location} has none: ` +
        'this is a replacement box. Run pnpm selfhost:rebuild first (README "Replace a dead box"); ' +
        'sealing here would make new platform keys and leave every stored credential unreadable'
    );
  }
  const localText = await local.readHead();
  const remoteText = bucketHead(bucket);
  if (localText !== null || remoteText !== null) {
    await assertHeadNotBehind(local, localText, remoteText, provider);
    // Not behind: a bundle only the bucket has is one this box superseded and pruned.
    return;
  }
  const newest = await newestLocalBundle(local);
  for (const id of onlyRemote) {
    const bundle = bucketBundleNamed(bucket, id);
    if (newest && bundle.createdAt >= newest.createdAt) {
      throw new Error(
        `the fleet bucket holds sealed bundle ${id} (${bundle.createdAt}), newer than any on this ` +
          'box: another box sealed it, or this box runs from an older copy of its state. ' +
          'Refusing to seal over it; finish the rebuild (pnpm selfhost:rebuild) or remove the ' +
          'other box'
      );
    }
  }
}

/**
 * The local store, with every write and removal repeated in the bucket, the head included. Reads
 * stay local: the agent and the deploy read the box's copy. A bucket failure after the local
 * write fails the caller before it deploys the bundle; the next deploy's reconcile uploads what
 * is missing. The replacement check runs here too, so `secrets switch` and `rotate` cannot seal
 * on an empty replacement either.
 */
export function mirroredBundleStore(
  local: BundleStore,
  bucket: BoxBucket,
  stateDir?: string
): BundleStore {
  return {
    location: `${local.location} (copied to the fleet bucket's ${BUNDLES_PREFIX})`,
    listIds: () => local.listIds(),
    read: (bundleId) => local.read(bundleId),
    async write(bundle) {
      if (stateDir) assertNoPendingRebuild(stateDir);
      await assertBoxNotBehindBucket(local, bucket);
      await local.write(bundle);
      const text = await local.read(bundle.bundleId);
      if (text === null) throw new Error(`bundle ${bundle.bundleId} vanished after it was written`);
      bucket.write(bundleKey(bundle.bundleId), text);
    },
    async remove(bundleId) {
      await local.remove(bundleId);
      if (bucketBundleIds(bucket).includes(bundleId)) bucket.remove([bundleKey(bundleId)]);
    },
    readHead: () => local.readHead(),
    withHeadLock: (fn) => local.withHeadLock(fn),
    async writeHead(text) {
      if (stateDir) assertNoPendingRebuild(stateDir);
      await local.writeHead(text);
      bucket.write(HEAD_KEY, text);
    },
    async removeHead() {
      await local.removeHead();
      if (bucket.list(BOX_MIRROR_PREFIX).includes(HEAD_KEY)) bucket.remove([HEAD_KEY]);
    },
  };
}

/** The newest bundle header in the local store by date, or null (boxes without a head). */
async function newestLocalBundle(local: BundleStore): Promise<SealedBundle | null> {
  let newest: SealedBundle | null = null;
  for (const id of await local.listIds()) {
    const text = await local.read(id);
    if (text === null) continue;
    const bundle = parseBundle(text);
    if (!newest || bundle.createdAt > newest.createdAt) newest = bundle;
  }
  return newest;
}

/**
 * Before a deploy seals anything: make the bucket's copy match the box. A bundle only the bucket
 * has is either one this box pruned (removed) or a later seal it never had (the bucket's head is
 * ahead of the box's, or the box has nothing at all): then this box is a replacement or a stale
 * copy, and sealing here would make new platform keys or roll secrets back, so the deploy stops.
 * The box's head then replaces the bucket's. A bundle of another
 * installation stops it too: one bucket (prefix) belongs to one installation, and this box must
 * never prune another's copy.
 */
/**
 * The box's head names a bundle the box lost but the bucket still holds: copy it back (the
 * selector verifies it opens before any deploy uses it). Neither holds it: stop, touching nothing.
 */
async function restoreHeadBundle(
  local: BundleStore,
  bucket: BoxBucket,
  localHead: string | null,
  localIds: Set<string>,
  remoteIds: readonly string[],
  log: (message: string) => void
): Promise<void> {
  const head = headHint(localHead);
  if (!head || localIds.has(head.bundleId)) return;
  if (!remoteIds.includes(head.bundleId)) {
    throw new Error(
      `the bundle head on this box names bundle ${head.bundleId}, which neither ${local.location} ` +
        'nor the fleet bucket holds. Restore it from backup (pnpm selfhost:restore)'
    );
  }
  const bundle = bucketBundleNamed(bucket, head.bundleId);
  if (bundle.installationId !== head.installationId) {
    throw new Error(
      `the fleet bucket's bundle ${head.bundleId} is of installation ${bundle.installationId}, ` +
        `not ${head.installationId}; refusing it`
    );
  }
  await local.write(bundle);
  localIds.add(head.bundleId);
  log(`restored bundle ${head.bundleId}, which the head names, from the fleet bucket`);
}

export async function reconcileBundleMirror(
  local: BundleStore,
  bucket: BoxBucket,
  log: (message: string) => void,
  provider: KeyProvider
): Promise<void> {
  await assertBoxNotBehindBucket(local, bucket, provider);
  const localIds = new Set(await local.listIds());
  const localHead = await local.readHead();
  const installationId = localHead
    ? (headHint(localHead) as BundleHead).installationId
    : (await newestLocalBundle(local))?.installationId;
  if (!installationId) return;
  const remoteIds = bucketBundleIds(bucket);
  await restoreHeadBundle(local, bucket, localHead, localIds, remoteIds, log);
  const stale: string[] = [];
  for (const id of remoteIds) {
    const bundle = bucketBundleNamed(bucket, id);
    if (bundle.installationId !== installationId) {
      throw new Error(
        `the fleet bucket holds sealed bundle ${id} of installation ${bundle.installationId}, ` +
          `not this box's ${installationId}: one bucket (or CELLD_BUCKET prefix) per ` +
          'installation; refusing to touch it'
      );
    }
    // Not on the box and not a later seal (assertBoxNotBehindBucket): a bundle it pruned.
    if (!localIds.has(id)) stale.push(bundleKey(id));
  }
  // Missing bundles first, then the head, then the stale ones: at every step the bucket's head
  // names a bundle the bucket holds, so a box that dies part way through can still be rebuilt.
  for (const id of localIds) {
    if (remoteIds.includes(id)) continue;
    const text = await local.read(id);
    if (text === null) continue;
    bucket.write(bundleKey(id), text);
    log(`copied bundle ${id} to the fleet bucket`);
  }
  // The box's head is at least as late as the bucket's (checked above): the bucket takes it.
  if (localHead !== null && bucketHead(bucket) !== localHead) {
    bucket.write(HEAD_KEY, localHead);
    log(`copied the bundle head to the fleet bucket (${HEAD_KEY})`);
  }
  if (stale.length > 0) {
    bucket.remove(stale);
    log(`removed ${stale.length} pruned bundle(s) from the fleet bucket copy`);
  }
}

/** The install record's entries a rebuilt box cannot re-derive: what the cloud bootstraps made. */
export function ledgerEntries(stateDir: string): CreatedResource[] {
  return readInstallRecord(stateDir).filter((r) => r.cloud !== 'box' && !r.removedAt);
}

/**
 * Seals the cloud entries with the box's key and replaces `sam-box/ledger.json`. Called after
 * reconcile, which refuses a bucket holding another installation's bundles; a ledger of another
 * installation with no bundles left (a restored clone's copy of its source) is stale and replaced.
 */
export async function publishLedger(
  bucket: BoxBucket,
  provider: KeyProvider,
  installationId: string,
  entries: readonly CreatedResource[]
): Promise<void> {
  const sealed = await sealSecrets({ [LEDGER_SECRET]: JSON.stringify(entries) }, provider, {
    installationId,
  });
  bucket.write(LEDGER_KEY, `${JSON.stringify(sealed, null, 2)}\n`);
}

function assertEntry(value: unknown): asserts value is CreatedResource {
  const r = value as Record<string, unknown> | null;
  const text = (v: unknown) => typeof v === 'string' && v !== '';
  if (
    !r ||
    typeof r !== 'object' ||
    !text(r.cloud) ||
    r.cloud === 'box' ||
    !text(r.kind) ||
    !text(r.name) ||
    !text(r.createdBy) ||
    (r.action !== 'created' && r.action !== 'reused') ||
    (r.attributes !== undefined &&
      (typeof r.attributes !== 'object' ||
        r.attributes === null ||
        Object.values(r.attributes).some((v) => typeof v !== 'string')))
  ) {
    throw new Error('the sealed ledger holds an invalid entry');
  }
}

/** The sealed ledger's entries, or null when there is none. Throws when it does not open. */
export async function fetchLedger(
  bucket: BoxBucket,
  provider: KeyProvider,
  installationId: string
): Promise<CreatedResource[] | null> {
  if (!bucket.list(BOX_MIRROR_PREFIX).includes(LEDGER_KEY)) return null;
  const sealed = parseBundle(bucket.read(LEDGER_KEY));
  if (sealed.installationId !== installationId) {
    throw new Error(
      `${LEDGER_KEY} belongs to installation ${sealed.installationId}, not ${installationId}`
    );
  }
  const secrets = await openBundle(sealed, provider);
  const names = Object.keys(secrets);
  if (names.length !== 1 || names[0] !== LEDGER_SECRET)
    throw new Error(`${LEDGER_KEY} is not a ledger`);
  const entries: unknown = JSON.parse(secrets[LEDGER_SECRET] ?? '');
  if (!Array.isArray(entries)) throw new Error(`${LEDGER_KEY} is not a ledger`);
  entries.forEach(assertEntry);
  return entries;
}
