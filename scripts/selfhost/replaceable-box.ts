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
 *   sam-box/ledger.json         the install record's cloud entries, sealed (no secret, but
 *                               teardown acts on them, so a bucket writer must not forge them)
 *
 * The key agent keeps reading its local copy, so it gains no bucket credential. The mode needs a
 * key held off the box: with the `file` provider the key would die with the box, and copying it
 * into the bucket would make the bucket alone enough to open every secret. So `file`,
 * `legacy-plaintext` and the bundled store (the bucket lives on the box) are refused.
 */
import type { CreatedResource } from '../../deploy/selfhost/created-resources.mjs';
import {
  BUNDLE_ID,
  openBundle,
  parseBundle,
  type SealedBundle,
  sealSecrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import type { BundleStore } from '../../deploy/selfhost/key-agent/bundle-store.ts';
import type { KeyProvider } from '../../deploy/selfhost/key-agent/provider.ts';
import { runCommand } from './backup-cli';
import type { BoxContext, Runner } from './backup-lib';
import { deleteObjects, listObjects, readObject, writeObject } from './bucket-objects';
import { readInstallRecord, usesBundledStore } from './install-record';

type Box = Readonly<Record<string, string | undefined>>;

export const BOX_MIRROR_PREFIX = 'sam-box/';
const BUNDLES_PREFIX = `${BOX_MIRROR_PREFIX}bundles/`;
export const LEDGER_KEY = `${BOX_MIRROR_PREFIX}ledger.json`;
/** The one secret name a sealed ledger holds; a bundle holding it is not a Worker bundle. */
export const LEDGER_SECRET = 'SAM_BOX_LEDGER';
/**
 * Providers whose key is held off the box. An allowlist, so a provider added later is refused
 * here until someone decides where its key lives.
 */
export const OFF_BOX_PROVIDERS: readonly string[] = ['gcp-kms', 'aws-kms', 'azure-kv', 'transit'];

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

/**
 * The local store, with every write and removal repeated in the bucket. Reads stay local: the
 * agent and the deploy read the box's copy. A bucket failure after the local write fails the
 * caller before it deploys the bundle; the next deploy's reconcile uploads what is missing.
 */
export function mirroredBundleStore(local: BundleStore, bucket: BoxBucket): BundleStore {
  return {
    location: `${local.location} (copied to the fleet bucket's ${BUNDLES_PREFIX})`,
    listIds: () => local.listIds(),
    read: (bundleId) => local.read(bundleId),
    async write(bundle) {
      await local.write(bundle);
      const text = await local.read(bundle.bundleId);
      if (text === null) throw new Error(`bundle ${bundle.bundleId} vanished after it was written`);
      bucket.write(bundleKey(bundle.bundleId), text);
    },
    async remove(bundleId) {
      await local.remove(bundleId);
      if (bucketBundleIds(bucket).includes(bundleId)) bucket.remove([bundleKey(bundleId)]);
    },
  };
}

/**
 * Before a deploy seals anything: make the bucket's copy match the box. A bundle only the bucket
 * has is either one this box pruned (older than its newest: removed) or one it never had (newer,
 * or the box has none at all): then this box is a replacement or a stale copy, and sealing here
 * would make new platform keys or roll secrets back, so the deploy stops.
 */
export async function reconcileBundleMirror(
  local: BundleStore,
  bucket: BoxBucket,
  log: (message: string) => void
): Promise<void> {
  const localIds = new Set(await local.listIds());
  const remoteIds = bucketBundleIds(bucket);
  const onlyRemote = remoteIds.filter((id) => !localIds.has(id));
  if (onlyRemote.length > 0 && localIds.size === 0) {
    throw new Error(
      `the fleet bucket holds ${onlyRemote.length} sealed bundle(s) of this install but ` +
        `${local.location} has none: this is a replacement box. Run pnpm selfhost:rebuild first ` +
        '(README "Replace a dead box"); sealing here would make new platform keys and leave every ' +
        'stored credential unreadable'
    );
  }
  let newestLocal = '';
  for (const id of localIds) {
    const text = await local.read(id);
    if (text === null) continue;
    const createdAt = parseBundle(text).createdAt;
    if (createdAt > newestLocal) newestLocal = createdAt;
  }
  const stale: string[] = [];
  for (const id of onlyRemote) {
    const bundle = readBucketBundle(bucket, id);
    if (bundle.createdAt >= newestLocal) {
      throw new Error(
        `the fleet bucket holds sealed bundle ${id} (${bundle.createdAt}), newer than any on this ` +
          'box: another box sealed it, or this box runs from an older copy of its state. ' +
          'Refusing to seal over it; rebuild this box from the bucket (pnpm selfhost:rebuild ' +
          'on an empty state directory) or remove the other box'
      );
    }
    stale.push(bundleKey(id));
  }
  if (stale.length > 0) {
    bucket.remove(stale);
    log(`removed ${stale.length} pruned bundle(s) from the fleet bucket copy`);
  }
  for (const id of localIds) {
    if (remoteIds.includes(id)) continue;
    const text = await local.read(id);
    if (text === null) continue;
    bucket.write(bundleKey(id), text);
    log(`copied bundle ${id} to the fleet bucket`);
  }
}

/** The install record's entries a rebuilt box cannot re-derive: what the cloud bootstraps made. */
export function ledgerEntries(stateDir: string): CreatedResource[] {
  return readInstallRecord(stateDir).filter((r) => r.cloud !== 'box' && !r.removedAt);
}

/** Seals the cloud entries with the box's key and replaces `sam-box/ledger.json`. */
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

/** The sealed ledger's entries, or [] when there is none. Throws when it does not open. */
export async function fetchLedger(
  bucket: BoxBucket,
  provider: KeyProvider,
  installationId: string
): Promise<CreatedResource[]> {
  if (!bucket.list(BOX_MIRROR_PREFIX).includes(LEDGER_KEY)) return [];
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
