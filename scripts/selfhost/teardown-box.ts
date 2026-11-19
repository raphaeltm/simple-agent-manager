/**
 * Teardown items on the box, in the object store and outside SAM (teardown.ts). Provider-neutral:
 * the box is Docker Compose and files; the bucket goes through bucket-objects.ts, which already
 * speaks gs:// and s3://. Cloud resources are teardown-gcp.ts's (and any later adapter's).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';

import type { CreatedResource } from '../../deploy/selfhost/created-resources.mjs';
import { type BoxContext, composeArgs, MANIFEST_NAME, parseBucketUrl } from './backup-lib';

import { composeProjectFor, expectedComposeProjectFor, usesBundledStore } from './install-record';
import { both, type Item, type Mode, STEPS } from './teardown-model';
import { readComposeInventory, stopContainers, removeContainers } from './teardown-compose';
import { isProtectedDir, stateItems } from './teardown-state-dir';

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
  /** Removes one path under .state (tests inject a failure); default removeTree. */
  removeTree?: (path: string) => void;
}

export function recorded(ctx: TeardownContext, kind: string, name?: string) {
  return ctx.record.find(
    (r) => r.cloud === 'box' && r.kind === kind && (name === undefined || r.name === name)
  );
}

export function boxItems(ctx: TeardownContext): Item[] {
  const items: Item[] = [];
  const projectName = composeProjectFor(ctx.box, ctx.stateDir);
  const project = recorded(ctx, 'compose-project', projectName);
  const owned =
    project?.action === 'created' &&
    projectName === expectedComposeProjectFor(ctx.box, ctx.stateDir);
  const composeGone = project?.removedAt ?? (existsSync(ctx.envFile) ? undefined : 'no .env left');
  const composeCmd = `docker ${composeArgs(ctx, []).join(' ')}`;
  const everything = ctx.mode === 'remove-everything';
  let inventory: ReturnType<typeof readComposeInventory> | undefined;
  let inventoryError: Error | undefined;
  if (owned) { try { inventory=readComposeInventory(ctx); } catch(error) { inventoryError=error instanceof Error ? error : new Error('Cannot verify Docker inventory'); } }
  const proof = () => { if(inventoryError) throw inventoryError; if(!inventory) throw new Error('Missing Docker ownership inventory'); return inventory; };

  items.push({
    id: 'box:stop',
    place: 'on the box',
    what: `services of compose project ${projectName} stopped (no new VMs or work start)`,
    provenance: project ? 'recorded' : 'discovered, not recorded',
    how: `${composeCmd} stop`,
    step: STEPS.stop,
    plan: both(
      owned
        ? { act: 'remove' }
        : { act: 'refused', why: 'no creation record for this installation compose project' }
    ),
    removedAt: composeGone,
    run: () => stopContainers(ctx,proof()),
  });
  items.push({
    id: 'box:containers',
    place: 'on the box',
    what: `containers and network of compose project ${projectName}`,
    provenance: project ? 'recorded' : 'discovered, not recorded',
    how: 'revalidate exact container ids and configuration scope, remove those ids; remove everything also removes individually proven volume identities',
    step: STEPS.box,
    plan: both(
      owned
        ? { act: 'remove' }
        : { act: 'refused', why: 'no creation record for this installation compose project' }
    ),
    removedAt: composeGone,
    runKey: 'compose-down',
    run: () =>
      removeContainers(ctx,proof(),everything),
    record: everything ? { cloud: 'box', kind: 'compose-project', name: projectName } : undefined,
  });
  const keepVolumes = { act: 'keep' as const, why: 'keep my data keeps volumes' };
  for (const volume of inventory?.volumes.map(v=>v.name) ?? []) {
    const store = volume.endsWith('objectstore-data');
    items.push({
      id: `box:volume:${volume}`,
      place: 'on the box',
      what: `volume ${volume}${store ? ' (the bundled object store: the fleet bucket)' : ''}`,
      provenance: 'discovered, not recorded',
      how: 'docker compose down -v',
      step: STEPS.box,
      plan: {
        'keep-data': keepVolumes,
        'remove-everything': owned
          ? { act: 'remove' }
          : { act: 'refused', why: 'no project creation record' },
      },
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
    what: `images compose built for ${projectName} (key agent, egress fence, celld, ...)`,
    provenance: 'discovered, not recorded',
    how: 'docker compose down --rmi local',
    step: STEPS.box,
    plan: {
      'keep-data': { act: 'keep', why: 'rebuilt or reused on start' },
      'remove-everything': { act: 'operator', why: 'images can be shared; remove unused images manually after inspecting their users' },
    },
    removedAt: composeGone,
  });
  if (owned) items.push(...stateItems(ctx), ...backupItems(ctx));
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
      'remove-everything':
        owned && env?.action === 'created' && env.name === ctx.envFile
          ? { act: 'remove' }
          : { act: 'refused', why: 'no canonical install env-file creation proof' },
    },
    removedAt: env?.removedAt ?? (existsSync(ctx.envFile) ? undefined : 'already gone'),
    run: () => rmSync(ctx.envFile, { force: true }),
    record: { cloud: 'box', kind: 'env-file', name: ctx.envFile },
  });
  return items;
}

/** A backup runBackup wrote: an absolute, unprotected directory with a version-1 manifest. */
function isBackupDir(path: string, ctx: TeardownContext): boolean {
  if (!isAbsolute(path) || isProtectedDir(path, ctx.selfhostDir)) return false;
  if (resolve(path) === resolve(ctx.stateDir)) return false;
  try {
    return existsSync(join(path, '.sam-backup-manifest'));
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
    const isBackup = entry?.action === 'created' && isBackupDir(path, ctx);
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
  const project = recorded(
    ctx,
    'compose-project',
    expectedComposeProjectFor(ctx.box, ctx.stateDir)
  );
  const owned =
    project?.action === 'created' && composeProjectFor(ctx.box, ctx.stateDir) === project.name;
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
          'remove-everything': owned
            ? { act: 'remove' }
            : { act: 'refused', why: 'no canonical project creation proof' },
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
      how: 'after verifying that no other installation uses these objects, remove this installation prefix in your object store console',
      step: STEPS.bucket,
      plan: {
        'keep-data': { act: 'keep', why: 'keep my data keeps the bucket' },
        // A configured URL/prefix is use, not creation proof. External data stays with the operator.
        'remove-everything': {
          act: 'operator',
          why: 'operator-managed store has no live creation proof; remove this installation data manually after verifying ownership',
        },
      },
      forGood:
        'every project, chat, setting and hosted repository of this install (backups excepted)',
      removedAt: contents?.removedAt,

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
          why: 'operator-managed bucket and contents are retained',
        },
      },
    });
  }
  return items;
}
