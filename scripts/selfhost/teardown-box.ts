/**
 * Teardown items on the box, in the object store and outside SAM (teardown.ts). Provider-neutral:
 * the box is Docker Compose and files; the bucket goes through bucket-objects.ts, which already
 * speaks gs:// and s3://. Cloud resources are teardown-gcp.ts's (and any later adapter's).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { homedir } from 'node:os';
import { basename, isAbsolute, join, relative, resolve } from 'node:path';

import type { CreatedResource } from '../../deploy/selfhost/created-resources.mjs';
import { type BoxContext, check, MANIFEST_NAME, parseBucketUrl } from './backup-lib';
import { deleteObjects, listObjects } from './bucket-objects';
import { COMPOSE_PROJECT, RECORD_FILE, usesBundledStore } from './install-record';
import { both, type Item, type Mode, STEPS } from './teardown-model';

export interface TeardownOptions {
  deleteBackups: boolean;
  destroyKey: boolean;
  adoptDiscovered: boolean;
  gcpProjects: string[];
}

export interface TeardownContext extends BoxContext {
  /** The mode being run; undefined for the inventory. */
  mode?: Mode;
  options: TeardownOptions;
  record: CreatedResource[];
  recordFile: string;
  domain: string;
  installationId: string | null;
  /** deploy/selfhost: where backups go by default. */
  selfhostDir: string;
}

/** Objects per `gcloud storage rm` / `mc rm` call. */
const BUCKET_DELETE_BATCH = 500;
const KEY_FILE = join('key-agent', 'kek');
const LEGACY_KEYS = 'platform-keys.json';

export function recorded(ctx: TeardownContext, kind: string, name?: string) {
  return ctx.record.find(
    (r) => r.cloud === 'box' && r.kind === kind && (name === undefined || r.name === name)
  );
}

function compose(ctx: TeardownContext, args: string[]): void {
  check(
    ctx.run('docker', ['compose', '-f', ctx.composeFile, '--env-file', ctx.envFile, ...args]),
    `docker compose ${args[0]}`
  );
}

export function boxItems(ctx: TeardownContext): Item[] {
  const items: Item[] = [];
  const project = recorded(ctx, 'compose-project', COMPOSE_PROJECT);
  const composeGone = project?.removedAt ?? (existsSync(ctx.envFile) ? undefined : 'no .env left');
  const composeCmd = `docker compose -f ${ctx.composeFile} --env-file ${ctx.envFile}`;
  const everything = ctx.mode === 'remove-everything';

  items.push({
    id: 'box:stop',
    place: 'on the box',
    what: `services of compose project ${COMPOSE_PROJECT} stopped (no new VMs or work start)`,
    provenance: project ? 'recorded' : 'discovered, not recorded',
    how: `${composeCmd} stop`,
    step: STEPS.stop,
    plan: both({ act: 'remove' }),
    removedAt: composeGone,
    run: () => compose(ctx, ['stop']),
  });
  items.push({
    id: 'box:containers',
    place: 'on the box',
    what: `containers and network of compose project ${COMPOSE_PROJECT}`,
    provenance: project ? 'recorded' : 'discovered, not recorded',
    how: `${composeCmd} down --remove-orphans (remove everything adds -v --rmi local)`,
    step: STEPS.box,
    plan: both({ act: 'remove' }),
    removedAt: composeGone,
    runKey: 'compose-down',
    run: () =>
      compose(ctx, ['down', '--remove-orphans', ...(everything ? ['-v', '--rmi', 'local'] : [])]),
    record: everything
      ? { cloud: 'box', kind: 'compose-project', name: COMPOSE_PROJECT }
      : undefined,
  });
  const keepVolumes = { act: 'keep' as const, why: 'keep my data keeps volumes' };
  for (const volume of composeVolumes(ctx)) {
    const store = volume.endsWith('objectstore-data');
    items.push({
      id: `box:volume:${volume}`,
      place: 'on the box',
      what: `volume ${volume}${store ? ' (the bundled object store: the fleet bucket)' : ''}`,
      provenance: 'discovered, not recorded',
      how: 'docker compose down -v',
      step: STEPS.box,
      plan: { 'keep-data': keepVolumes, 'remove-everything': { act: 'remove' } },
      forGood: store
        ? 'every project, chat, setting and hosted repository of this install'
        : undefined,
      removedAt: composeGone,
      runKey: 'compose-down',
      record: { cloud: 'box', kind: 'volume', name: volume, createdBy: 'compose' },
    });
  }
  items.push({
    id: 'box:images',
    place: 'on the box',
    what: `images compose built for ${COMPOSE_PROJECT} (key agent, egress fence, celld, ...)`,
    provenance: 'discovered, not recorded',
    how: 'docker compose down --rmi local',
    step: STEPS.box,
    plan: {
      'keep-data': { act: 'keep', why: 'rebuilt or reused on start' },
      'remove-everything': { act: 'remove' },
    },
    removedAt: composeGone,
    runKey: 'compose-down',
  });
  items.push(...stateItems(ctx), ...backupItems(ctx));
  const env = recorded(ctx, 'env-file');
  items.push({
    id: 'box:env',
    place: 'on the box',
    what: `${ctx.envFile} (settings and the bucket credential)`,
    provenance: env ? 'recorded' : 'discovered, not recorded',
    how: `rm ${ctx.envFile} (last, so a failed run can be resumed)`,
    step: STEPS.box,
    plan: {
      'keep-data': { act: 'keep', why: 'needed to start the install again' },
      'remove-everything': { act: 'remove' },
    },
    removedAt: env?.removedAt ?? (existsSync(ctx.envFile) ? undefined : 'already gone'),
    run: () => rmSync(ctx.envFile, { force: true }),
    record: { cloud: 'box', kind: 'env-file', name: ctx.envFile },
  });
  return items;
}

function composeVolumes(ctx: TeardownContext): string[] {
  const result = ctx.run('docker', [
    'volume',
    'ls',
    '--filter',
    `label=com.docker.compose.project=${COMPOSE_PROJECT}`,
    '--format',
    '{{.Name}}',
  ]);
  if (result.status !== 0) return [];
  return result.stdout
    .split('\n')
    .map((v) => v.trim())
    .filter(Boolean);
}

function stateItems(ctx: TeardownContext): Item[] {
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
      step: STEPS.box,
      plan: keyDecision,
      forGood:
        'every sealed bundle and every backup of this box sealed with this key can never be opened again, unless you keep a copy',
      runKey: 'state',
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
      step: STEPS.box,
      plan: keyDecision,
      forGood: 'the box copy of the platform keys; backups hold their own copy',
      runKey: 'state',
      record: { cloud: 'box', kind: 'platform-keys', name: legacyKeys, createdBy: 'deploy' },
    });
  }
  const state = recorded(ctx, 'state-dir');
  items.push({
    id: 'box:state',
    place: 'on the box',
    what: `${ctx.stateDir} (sealed bundles, generated config, deploy project, celld binary, caches, secrets.env)`,
    provenance: state ? 'recorded' : 'discovered, not recorded',
    how: `rm -r everything in ${ctx.stateDir} except ${RECORD_FILE} and a key that is kept`,
    step: STEPS.box,
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
    step: STEPS.box,
    plan: both({ act: 'keep', why: 'the receipt a second run resumes from' }),
  });
  return items;
}

/** Everything in .state except the record, and the keys when they are kept. */
function clearState(ctx: TeardownContext, keepKey: boolean): void {
  assertStateDir(ctx);
  for (const entry of readdirSync(ctx.stateDir)) {
    if (entry === RECORD_FILE || (keepKey && entry === LEGACY_KEYS)) continue;
    const path = join(ctx.stateDir, entry);
    if (entry === 'key-agent' && keepKey) {
      for (const inner of readdirSync(path)) {
        if (inner !== basename(KEY_FILE))
          rmSync(join(path, inner), { recursive: true, force: true });
      }
      continue;
    }
    rmSync(path, { recursive: true, force: true });
  }
}

/** True for `/`, the home directory, and any directory that contains the checkout. */
function isProtectedDir(path: string, selfhostDir: string): boolean {
  const target = resolve(path);
  if (target === '/' || target === resolve(homedir())) return true;
  const rel = relative(target, resolve(selfhostDir));
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel));
}

/**
 * The state directory comes from .env or --state-dir, so prove it is SAM's before emptying it
 * (security review M1): not a protected directory, and either recorded as this state dir or
 * holding the key agent's files.
 */
function assertStateDir(ctx: TeardownContext): void {
  if (isProtectedDir(ctx.stateDir, ctx.selfhostDir)) {
    throw new Error(`refused: ${ctx.stateDir} is /, your home or contains the checkout`);
  }
  const recordedHere = ctx.record.some(
    (r) => r.cloud === 'box' && r.kind === 'state-dir' && resolve(r.name) === resolve(ctx.stateDir)
  );
  if (
    !recordedHere &&
    !existsSync(join(ctx.stateDir, 'key-agent')) &&
    !existsSync(join(ctx.stateDir, LEGACY_KEYS))
  ) {
    throw new Error(
      `refused: ${ctx.stateDir} is neither recorded as this install's state nor holds its keys`
    );
  }
}

/** A backup runBackup wrote: an absolute, unprotected directory with a version-1 manifest. */
function isBackupDir(path: string, ctx: TeardownContext): boolean {
  if (!isAbsolute(path) || isProtectedDir(path, ctx.selfhostDir)) return false;
  if (resolve(path) === resolve(ctx.stateDir)) return false;
  try {
    const manifest = JSON.parse(readFileSync(join(path, MANIFEST_NAME), 'utf8')) as unknown;
    return (manifest as { version?: unknown }).version === 1;
  } catch {
    return false;
  }
}

function endpointHost(endpoint: string | undefined): string {
  if (!endpoint) return 'your S3 endpoint';
  try {
    return new URL(endpoint).host; // never userinfo
  } catch {
    return 'your S3 endpoint';
  }
}

function backupItems(ctx: TeardownContext): Item[] {
  const paths = new Map<string, CreatedResource | undefined>();
  for (const r of ctx.record) if (r.cloud === 'box' && r.kind === 'backup') paths.set(r.name, r);
  const defaultDir = join(ctx.selfhostDir, 'backups');
  if (existsSync(defaultDir)) {
    for (const entry of readdirSync(defaultDir)) {
      const path = join(defaultDir, entry);
      if (!paths.has(path) && existsSync(join(path, MANIFEST_NAME))) paths.set(path, undefined);
    }
  }
  const items: Item[] = [];
  for (const [path, entry] of paths) {
    if (entry?.removedAt && !existsSync(path)) continue;
    // Proof it is a backup: the manifest runBackup writes. A recorded path without one is refused.
    const isBackup = isBackupDir(path, ctx);
    const gone = !existsSync(path);
    items.push({
      id: `box:backup:${path}`,
      place: 'on the box',
      what: `backup ${path}${backupBucket(path)}`,
      provenance: entry ? 'recorded' : 'discovered, not recorded',
      how: `rm -r ${path}`,
      step: STEPS.box,
      plan: gone
        ? both({ act: 'keep', why: 'no longer on disk' })
        : !isBackup
          ? both({
              act: 'refused',
              why: `not proven a backup (needs an absolute path, a version-1 ${MANIFEST_NAME}, and not /, home or the checkout)`,
            })
          : {
              'keep-data': { act: 'keep', why: 'keep my data keeps backups' },
              'remove-everything': ctx.options.deleteBackups
                ? { act: 'remove' }
                : { act: 'keep', why: 'pass --delete-backups to delete backups' },
            },
      forGood: 'this backup can never be restored',
      run: () => rmSync(path, { recursive: true, force: true }),
      record: { cloud: 'box', kind: 'backup', name: path, createdBy: 'backup' },
    });
  }
  return items;
}

function backupBucket(path: string): string {
  try {
    const manifest = JSON.parse(readFileSync(join(path, MANIFEST_NAME), 'utf8')) as unknown;
    const created = (manifest as { createdAt?: unknown }).createdAt;
    return typeof created === 'string' ? ` (taken ${created})` : '';
  } catch {
    return '';
  }
}

export function bucketItems(ctx: TeardownContext): Item[] {
  const url = ctx.box.CELLD_BUCKET ?? recorded(ctx, 'bucket')?.name;
  if (!url) return [];
  const entry = recorded(ctx, 'bucket', url);
  const contents = recorded(ctx, 'bucket-contents', url);
  if (usesBundledStore(ctx.box)) {
    return [
      {
        id: 'bucket:bundled',
        place: 'in the object store',
        what: `fleet bucket ${url} in the bundled store (celld state, deploy versions, vm-agent releases, hosted git)`,
        provenance: entry ? 'recorded' : 'discovered, not recorded',
        how: 'removed with the objectstore-data volume',
        step: STEPS.box,
        plan: {
          'keep-data': { act: 'keep', why: 'keep my data keeps the bucket' },
          'remove-everything': { act: 'remove' },
        },
        removedAt: entry?.removedAt,
        runKey: 'compose-down',
        record: { cloud: 'box', kind: 'bucket', name: url },
      },
    ];
  }
  const parsed = parseBucketUrl(url);
  const items: Item[] = [
    {
      id: 'bucket:contents',
      place: 'in the object store',
      what: `every object under ${url} (celld state, deploy versions, vm-agent releases, hosted git)`,
      provenance: entry ? 'recorded' : 'discovered, not recorded',
      how:
        parsed.prefix || entry?.action === 'created'
          ? `list, then delete in batches of ${BUCKET_DELETE_BATCH} (${parsed.scheme === 'gs' ? 'gcloud storage rm' : 'mc rm'}); only under this prefix`
          : `if the bucket holds only SAM's objects: ${parsed.scheme === 'gs' ? `gcloud storage rm --recursive 'gs://${parsed.bucket}/**'` : `mc rm --recursive --force <alias>/${parsed.bucket}`}`,
      step: STEPS.bucket,
      plan: {
        'keep-data': { act: 'keep', why: 'keep my data keeps the bucket' },
        // A bucket you brought with no prefix of SAM's own may hold anything else: teardown
        // empties only a prefix, or a bucket the install created (security review H1).
        'remove-everything':
          parsed.prefix || entry?.action === 'created'
            ? { act: 'remove' }
            : {
                act: 'operator',
                why: 'your bucket has no SAM prefix, so teardown cannot tell SAM objects from anything else in it',
              },
      },
      forGood:
        'every project, chat, setting and hosted repository of this install (backups excepted)',
      removedAt: contents?.removedAt,
      run: () => emptyBucket(ctx, url),
      record: { cloud: 'box', kind: 'bucket-contents', name: url, createdBy: 'deploy' },
    },
  ];
  if (entry?.action !== 'created') {
    items.push({
      id: 'bucket:itself',
      place: 'in the object store',
      what: `the bucket ${parsed.bucket} itself (you created it)`,
      provenance: entry ? 'recorded' : 'discovered, not recorded',
      how:
        parsed.scheme === 'gs'
          ? `gcloud storage buckets delete gs://${parsed.bucket} (only if nothing else uses it)`
          : `delete bucket ${parsed.bucket} at ${endpointHost(ctx.box.S3_ENDPOINT)} in your provider's console`,
      step: STEPS.outside,
      plan: {
        'keep-data': { act: 'keep', why: 'keep my data keeps the bucket' },
        'remove-everything': {
          act: 'operator',
          why: 'it existed before SAM; teardown empties it only',
        },
      },
    });
  }
  return items;
}

/** Deletes every object under the bucket prefix, refusing a bucket that is not celld's. */
export function emptyBucket(ctx: BoxContext, url: string): void {
  const objects = listObjects(ctx, '');
  if (objects.length === 0) return;
  if (!objects.some((o) => o.key.startsWith('deploy/'))) {
    throw new Error(
      `refused: ${url} holds ${objects.length} objects but no celld deploy/ tree, so it is not proven this install's fleet bucket`
    );
  }
  const keys = objects.map((o) => o.key);
  for (let i = 0; i < keys.length; i += BUCKET_DELETE_BATCH) {
    deleteObjects(ctx, keys.slice(i, i + BUCKET_DELETE_BATCH));
  }
  const left = listObjects(ctx, '').length;
  if (left > 0) throw new Error(`${left} objects are still under ${url} (written while deleting?)`);
}
