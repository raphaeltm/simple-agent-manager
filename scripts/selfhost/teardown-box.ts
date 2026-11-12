/**
 * Teardown items on the box, in the object store and outside SAM (teardown.ts). Provider-neutral:
 * the box is Docker Compose and files; the bucket goes through bucket-objects.ts, which already
 * speaks gs:// and s3://. Cloud resources are teardown-gcp.ts's (and any later adapter's).
 */
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { basename, join } from 'node:path';

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
    const isBackup = existsSync(join(path, MANIFEST_NAME));
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
          ? both({ act: 'refused', why: `no ${MANIFEST_NAME} in it, so not proven a backup` })
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
      how: `list, then delete in batches of ${BUCKET_DELETE_BATCH} (${parsed.scheme === 'gs' ? 'gcloud storage rm' : 'mc rm'}); only under this prefix`,
      step: STEPS.bucket,
      plan: {
        'keep-data': { act: 'keep', why: 'keep my data keeps the bucket' },
        'remove-everything': { act: 'remove' },
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
          : `delete bucket ${parsed.bucket} at ${ctx.box.S3_ENDPOINT ?? 'your S3 endpoint'} in your provider's console`,
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

export function outsideItems(ctx: TeardownContext): Item[] {
  const domain = ctx.domain || '<your SAM domain>';
  const keep = { act: 'keep' as const, why: 'needed to bring the install back' };
  const operator = (why: string) => ({
    'keep-data': keep,
    'remove-everything': { act: 'operator' as const, why },
  });
  const items: Item[] = [
    {
      id: 'outside:github-app',
      place: 'outside SAM',
      what: 'the GitHub App created through Admin → Integrations (manifest flow), if you made one',
      provenance: 'from the setup steps',
      how: `github.com → Settings → Developer settings → GitHub Apps (for an organization: its Settings → Developer settings → GitHub Apps) → the App whose URL is https://app.${domain} → Advanced → Delete GitHub App. Its installations go with it`,
      step: STEPS.outside,
      plan: operator('GitHub deletes Apps only in its own settings'),
    },
    {
      id: 'outside:dns',
      place: 'outside SAM',
      what: `DNS: the wildcard record *.${domain} you pointed at the box`,
      provenance: 'from the setup steps',
      how: `remove it at your DNS host (Google Cloud DNS: gcloud dns record-sets delete '*.${domain}.' --type=A --zone=<zone>)`,
      step: STEPS.outside,
      plan: operator('teardown has no access to your DNS host'),
    },
    {
      id: 'outside:box',
      place: 'outside SAM',
      what: 'the machine itself, and on a cloud its service account and the bucket grant you gave it',
      provenance: 'from the setup steps',
      how: 'delete them in your cloud console (Google Cloud: gcloud compute instances delete <box> --zone <zone>; gcloud iam service-accounts delete <box account>), and this checkout with rm -r',
      step: STEPS.outside,
      plan: operator('you created them; teardown runs on the box'),
    },
    {
      id: 'outside:accounts',
      place: 'outside SAM',
      what: 'OAuth clients and SMTP relay credentials you registered for this install',
      provenance: 'from the setup steps',
      how: 'delete or revoke them in each service (GitHub OAuth Apps, Google Cloud OAuth clients, your SMTP provider)',
      step: STEPS.outside,
      plan: operator('teardown has no access to those services'),
    },
    {
      id: 'outside:other-clouds',
      place: 'in your cloud, made by SAM at runtime',
      what: 'node VMs on any provider other than Google Cloud (Hetzner, Scaleway, AWS, ...)',
      provenance: 'from the setup steps',
      how: `before teardown, delete every node in Admin → Nodes while SAM runs; or in the provider's console delete servers labelled managed=simple-agent-manager and installation=${ctx.installationId ?? '<installation id>'}`,
      step: STEPS.compute,
      plan: both({ act: 'operator', why: 'only the Google Cloud adapter exists so far' }),
    },
  ];
  const profiles = (ctx.box.COMPOSE_PROFILES ?? '').split(',').map((p) => p.trim());
  if (profiles.includes('mail-in')) {
    items.push({
      id: 'outside:mail',
      place: 'outside SAM',
      what: `inbound mail: the MX record agents.${domain} and the port 25 firewall rule you opened`,
      provenance: 'from the setup steps',
      how: `remove the MX record at your DNS host; Google Cloud: gcloud compute firewall-rules delete sam-smtp-in --project <project>`,
      step: STEPS.outside,
      plan: operator('you created them by hand (README, Inbound agent email)'),
    });
  }
  const provider = keyProvider(ctx.stateDir);
  if (provider === 'aws-kms' || provider === 'azure-kv') {
    items.push({
      id: `outside:${provider}`,
      place: 'outside SAM',
      what: `the ${provider === 'aws-kms' ? 'AWS KMS' : 'Azure Key Vault'} key that seals this box`,
      provenance: 'from the setup steps',
      how: 'README, Removing what setup created: the AWS or Azure commands',
      step: STEPS.outside,
      plan: {
        'keep-data': { act: 'keep', why: 'keep my data keeps the key' },
        'remove-everything': ctx.options.destroyKey
          ? { act: 'operator', why: 'you created it; no bootstrap for this cloud yet' }
          : { act: 'keep', why: 'pass --destroy-key to be told how to delete it' },
      },
      forGood: 'every sealed bundle and every backup sealed with it becomes unrecoverable',
    });
  }
  return items;
}

function keyProvider(stateDir: string): string | null {
  try {
    const choice = JSON.parse(
      readFileSync(join(stateDir, 'key-agent', 'choice.json'), 'utf8')
    ) as unknown;
    const provider = (choice as { provider?: unknown }).provider;
    return typeof provider === 'string' ? provider : null;
  } catch {
    return null;
  }
}
