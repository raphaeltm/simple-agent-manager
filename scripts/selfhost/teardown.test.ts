/**
 * `pnpm selfhost:teardown` through its real entry point (teardown.ts as a child process), on an
 * install made by the real `pnpm selfhost:deploy --init` and the real gcp-bootstrap.sh, against a
 * fake `gcloud` (Google Cloud state as one JSON file: IAM, KMS, Compute and Cloud Storage) and a
 * fake `docker` (compose and volumes). Node VMs are seeded as SAM's provider creates them, with the
 * labels buildNodeProviderLabels sets.
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, CLOSED_HOST, runDeploy, runTsx } from './deploy-harness.js';
import { recordBackup } from './install-record.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

const TEARDOWN = resolve(import.meta.dirname, 'teardown.ts');
const BOOTSTRAP = resolve(import.meta.dirname, '../../deploy/selfhost/gcp-bootstrap.sh');
const DOMAIN = 'sam.example.com';
const ISSUER = `https://api.${DOMAIN}`;
const PROJECT = 'sam-test-proj';
const BOX_SA = `sam-box@${PROJECT}.iam.gserviceaccount.com`;
const OTHER_INSTALL = 'ffffffffffffffffffffffffffffffff';
const ZONE_URL = `https://www.googleapis.com/compute/v1/projects/${PROJECT}/zones/europe-west1-b`;
const VOLUMES = [
  'sam-selfhost_celld-data',
  'sam-selfhost_caddy-data',
  'sam-selfhost_objectstore-data',
];

let dir: string;
let state: string;
let fake: string;
let bin: string;
let envFile: string;

interface FakeGcp {
  pools: Record<string, { description: string }>;
  providers: Record<string, { issuer: string }>;
  accounts: Record<string, { description: string }>;
  bindings: string[];
  rings: Record<string, object>;
  keys: Record<string, { labels: Record<string, string>; versions: Record<string, string> }>;
  instances: Array<Record<string, unknown> & { name: string; labels: Record<string, string> }>;
  disks: Record<string, { users: string[] }>;
  firewalls: Record<string, object>;
  objects: Record<string, number>;
}

const gcp = (): FakeGcp => JSON.parse(readFileSync(join(fake, 'gcp.json'), 'utf8')) as FakeGcp;
function setGcp(update: (db: FakeGcp) => void): void {
  const db = gcp();
  update(db);
  writeFileSync(join(fake, 'gcp.json'), JSON.stringify(db));
}
const docker = () =>
  JSON.parse(readFileSync(join(fake, 'docker.json'), 'utf8')) as {
    running: boolean;
    volumes: string[];
    images: boolean;
  };
const lines = (file: string) =>
  existsSync(join(fake, file)) ? readFileSync(join(fake, file), 'utf8').trim().split('\n') : [];
const record = () =>
  JSON.parse(readFileSync(join(state, 'created-resources.json'), 'utf8')) as {
    resources: Array<{
      cloud: string;
      kind: string;
      name: string;
      action: string;
      removedAt?: string;
    }>;
  };
const installationId = () => record().resources.find((r) => r.kind === 'installation')!.name;

const fakeEnv = () => ({ PATH: `${bin}:${process.env.PATH}`, STATE: fake });

function vm(name: string, installation: string, extra: Partial<Record<string, string>> = {}) {
  return {
    id: String(Math.floor(Math.random() * 1e15)),
    name,
    zone: ZONE_URL,
    labels: {
      managed: 'simple-agent-manager',
      installation,
      env: 'selfhost',
      node: name,
      role: 'workspace',
      ...extra,
    },
    disks: [{ source: `${ZONE_URL}/disks/${name}`, autoDelete: true }],
  };
}

function bootstrap(args: string[]) {
  const result = spawnSync(
    'bash',
    [
      BOOTSTRAP,
      '--project',
      PROJECT,
      '--api-url',
      ISSUER,
      '--skip-issuer-check',
      '--state-dir',
      state,
      ...args,
    ],
    { encoding: 'utf8', env: { ...process.env, ...fakeEnv() } }
  );
  expect(result.status, result.stderr).toBe(0);
}

/** An install as an operator makes it: --init, the GCP bootstrap with --kms, a backup, live nodes. */
async function install(): Promise<void> {
  const init = await runDeploy(envFile, ['--init']);
  expect(init.status, init.out).toBe(0);
  bootstrap(['--kms', '--box-service-account', BOX_SA]);
  const backup = join(dir, 'backups', '2026-11-12T00-00-00Z');
  mkdirSync(backup, { recursive: true });
  writeFileSync(
    join(backup, 'backup-manifest.json'),
    JSON.stringify({ version: 1, createdAt: '2026-11-12T00:00:00Z' })
  );
  recordBackup(state, backup);
  const id = installationId();
  setGcp((db) => {
    db.instances = [
      vm('sam-node-a', id),
      {
        ...vm('sam-node-b', id),
        disks: [
          { source: `${ZONE_URL}/disks/sam-node-b`, autoDelete: true },
          { source: `${ZONE_URL}/disks/sam-data-b`, autoDelete: false },
        ],
      },
      vm('sam-node-other', OTHER_INSTALL),
    ];
    db.disks = {
      'sam-node-a': { users: ['a'] },
      'sam-node-b': { users: ['b'] },
      'sam-data-b': { users: ['b'] },
      'sam-node-other': { users: ['o'] },
    };
    db.firewalls = { 'sam-allow-agent': {}, 'sam-allow-app-routes': {} };
    db.objects = {
      'gs://fleet/celld/deploy/current.json': 10,
      'gs://fleet/celld/deploy/workspaces-api/v1/manifest.json': 20,
      'gs://fleet/celld/d1/main.sqlite': 30,
      'gs://fleet/other/keep.txt': 5,
    };
  });
  writeFileSync(
    join(fake, 'docker.json'),
    JSON.stringify({ running: true, volumes: VOLUMES, images: true })
  );
}

function teardown(args: string[], env: Record<string, string> = {}) {
  return runTsx(TEARDOWN, ['--box-env', envFile, ...args], { ...fakeEnv(), ...env });
}

/** Everything teardown could change, for "nothing changed" checks. */
function snapshot(): string {
  const files = (root: string): string[] =>
    existsSync(root)
      ? readdirSync(root, { withFileTypes: true }).flatMap((e) =>
          e.isDirectory()
            ? files(join(root, e.name)).map((f) => `${e.name}/${f}`)
            : [`${e.name}:${readFileSync(join(root, e.name), 'utf8')}`]
        )
      : [];
  return JSON.stringify({ gcp: gcp(), docker: docker(), box: files(dir) });
}

const MUTATING_GCLOUD =
  / (create|delete|destroy|remove-iam-policy-binding|add-iam-policy-binding)|^storage rm/;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'teardown-box-'));
  state = join(dir, '.state');
  fake = mkdtempSync(join(tmpdir(), 'teardown-fake-'));
  bin = mkdtempSync(join(tmpdir(), 'teardown-bin-'));
  for (const [tool, script] of [
    ['gcloud', 'fake-gcloud-iam.mjs'],
    ['docker', 'fake-docker-teardown.mjs'],
  ] as const) {
    writeFileSync(
      join(bin, tool),
      `#!/usr/bin/env bash\nexec node ${JSON.stringify(resolve(import.meta.dirname, 'testdata', script))} "$@"\n`
    );
    chmodSync(join(bin, tool), 0o755);
  }
  envFile = join(dir, '.env');
  writeFileSync(
    envFile,
    [
      `SAM_DOMAIN=${DOMAIN}`,
      'SAM_TLS_MODE=internal',
      'COMPOSE_PROFILES=tunnel,gce',
      'CELLD_BUCKET=gs://fleet/celld',
      `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
      `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
      `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
      '',
    ].join('\n'),
    { mode: 0o600 }
  );
  return () => {
    for (const d of [dir, fake, bin]) rmSync(d, { recursive: true, force: true });
  };
});

describe('pnpm selfhost:teardown', () => {
  it('inventory lists what --init, the bootstrap, a backup and SAM at runtime created, and changes nothing', async () => {
    await install();
    const before = snapshot();
    const callsBefore = lines('calls').length;
    const result = await teardown([]);
    expect(result.status, result.out).toBe(0);
    const out = result.out;
    expect(out).toContain(`installation ${installationId()} (recorded)`);
    // box
    expect(out).toContain('services of compose project sam-selfhost stopped');
    for (const v of VOLUMES) expect(out).toContain(`volume ${v}`);
    expect(out).toContain(`key file ${join(state, 'key-agent/kek')}`);
    expect(out).toContain(`backup ${join(dir, 'backups', '2026-11-12T00-00-00Z')}`);
    expect(out).toContain('every object under gs://fleet/celld');
    // bootstrap: every recorded resource
    for (const r of record().resources.filter((e) => e.cloud === 'gcp'))
      expect(out).toContain(`${r.kind} ${r.name}`);
    // runtime: own VMs removable, the other install's refused, firewall rules left for you
    expect(out).toMatch(/node VM sam-node-a .*\n.*\n.*keep my data: removed/);
    expect(out).toMatch(
      /node VM sam-node-other[^\n]*\n[^\n]*\n[^\n]*refused \(labelled installation=f{32}/
    );
    expect(out).toMatch(/firewall rule sam-allow-agent[\s\S]*?remove everything: left for you/);
    // outside
    expect(out).toContain('GitHub App');
    expect(out).toContain(`*.${DOMAIN}`);
    expect(out).toContain('Read only: nothing was changed.');
    expect(snapshot()).toBe(before);
    expect(
      lines('calls')
        .slice(callsBefore)
        .filter((c) => MUTATING_GCLOUD.test(` ${c}`))
    ).toEqual([]);
  });

  it('dry run of either mode changes nothing and prints the plan', async () => {
    await install();
    const before = snapshot();
    const callsBefore = lines('calls').length;
    for (const mode of ['--keep-data', '--remove-everything']) {
      const result = await teardown(
        [mode, '--dry-run', '--delete-backups', '--destroy-key'].filter(
          (a) => mode === '--remove-everything' || !a.startsWith('--de')
        )
      );
      expect(result.status, result.out).toBe(0);
      expect(result.out).toContain('Step 2: node VMs and disks');
      expect(result.out).toContain('Dry run: nothing was changed.');
    }
    expect(snapshot()).toBe(before);
    expect(
      lines('calls')
        .slice(callsBefore)
        .filter((c) => MUTATING_GCLOUD.test(` ${c}`))
    ).toEqual([]);
    expect(lines('docker-calls').filter((c) => / (stop|down)\b/.test(c))).toEqual([]);
  });

  it('refuses without the matching confirmation and changes nothing', async () => {
    await install();
    const before = snapshot();
    const result = await teardown(['--remove-everything', '--confirm', 'other.example.com']);
    expect(result.status).toBe(1);
    expect(result.out).toContain(`pass --confirm ${DOMAIN}`);
    expect(snapshot()).toBe(before);
  });

  it('keep my data: removes compute and cloud identity, keeps bucket, backups, key, bundles; the install comes back', async () => {
    await install();
    const bundlesBefore = readdirSync(join(state, 'key-agent/bundles'));
    const kek = readFileSync(join(state, 'key-agent/kek'), 'utf8');
    const result = await teardown(['--keep-data', '--confirm', DOMAIN]);
    expect(result.status, result.out).toBe(0);
    const db = gcp();
    expect(db.instances.map((i) => i.name)).toEqual(['sam-node-other']);
    expect(db.disks['sam-data-b']).toBeUndefined();
    expect(Object.keys(db.pools)).toEqual([]);
    expect(Object.keys(db.providers)).toEqual([]);
    expect(Object.keys(db.accounts)).toEqual([]);
    expect(Object.keys(db.keys)).toHaveLength(1); // key, ring and the box's grant stay
    expect(db.bindings.some((b) => b.includes(BOX_SA))).toBe(true);
    expect(Object.keys(db.firewalls).sort()).toEqual(['sam-allow-agent', 'sam-allow-app-routes']);
    expect(Object.keys(db.objects)).toHaveLength(4);
    expect(docker()).toEqual({ running: false, volumes: VOLUMES, images: true });
    expect(lines('docker-calls').find((c) => c.includes(' down'))).not.toMatch(/ -v\b|--rmi/);
    expect(readdirSync(join(state, 'key-agent/bundles'))).toEqual(bundlesBefore);
    expect(readFileSync(join(state, 'key-agent/kek'), 'utf8')).toBe(kek);
    expect(existsSync(envFile)).toBe(true);
    expect(existsSync(join(dir, 'backups', '2026-11-12T00-00-00Z', 'backup-manifest.json'))).toBe(
      true
    );
    expect(result.out).toMatch(/Removed:[\s\S]*node VM sam-node-a/);
    expect(result.out).toMatch(/Refused \(ownership not proven\):[\s\S]*sam-node-other/);
    expect(
      record().resources.find((r) => r.name.endsWith('/instances/sam-node-a'))?.removedAt
    ).toBeTruthy();

    // Brought back: the same bundles open on the next --init, and the bootstrap recreates identity.
    const again = await runDeploy(envFile, ['--init']);
    expect(again.status, again.out).toBe(0);
    expect(readdirSync(join(state, 'key-agent/bundles'))).toEqual(bundlesBefore);
    bootstrap([]);
    expect(Object.keys(gcp().pools)).toHaveLength(1);
  });

  it('remove everything leaves nothing the record lists, except a backup and a key without their flags', async () => {
    await install();
    const result = await teardown(['--remove-everything', '--confirm', DOMAIN]);
    expect(result.status, result.out).toBe(0);
    const db = gcp();
    expect(db.instances.map((i) => i.name)).toEqual(['sam-node-other']);
    expect(Object.keys(db.objects)).toEqual(['gs://fleet/other/keep.txt']);
    expect(Object.keys(db.pools).concat(Object.keys(db.accounts))).toEqual([]);
    expect(db.bindings).toEqual([]);
    expect(Object.values(db.keys).map((k) => Object.values(k.versions))).toEqual([['ENABLED']]);
    expect(docker()).toEqual({ running: false, volumes: [], images: false });
    expect(existsSync(envFile)).toBe(false);
    expect(readdirSync(state).sort()).toEqual(['created-resources.json', 'key-agent']);
    expect(readdirSync(join(state, 'key-agent'))).toEqual(['kek']);
    expect(existsSync(join(dir, 'backups', '2026-11-12T00-00-00Z'))).toBe(true);
    const left = record().resources.filter((r) => !r.removedAt && r.action === 'created');
    expect(left.map((r) => `${r.kind} ${r.name}`).sort()).toEqual(
      record()
        .resources.filter((r) => ['kms-key', 'kms-key-ring', 'backup'].includes(r.kind))
        .map((r) => `${r.kind} ${r.name}`)
        .sort()
    );
    expect(result.out).toMatch(
      /Left by choice:[\s\S]*pass --destroy-key[\s\S]*pass --delete-backups/
    );
    expect(result.out).toMatch(
      /Left for you:[\s\S]*firewall rule sam-allow-agent[\s\S]*gcloud compute firewall-rules delete/
    );

    // A second run finds nothing left to do and still names the install from the record.
    const second = await teardown(['--remove-everything', '--confirm', DOMAIN]);
    expect(second.status, second.out).toBe(0);
    expect(second.out).not.toMatch(/^Failed:/m);
  });

  it('--delete-backups and --destroy-key remove the backup, the key file and schedule the KMS key destruction', async () => {
    await install();
    const result = await teardown([
      '--remove-everything',
      '--delete-backups',
      '--destroy-key',
      '--confirm',
      DOMAIN,
    ]);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(join(dir, 'backups', '2026-11-12T00-00-00Z'))).toBe(false);
    expect(readdirSync(state)).toEqual(['created-resources.json']);
    expect(Object.values(gcp().keys).map((k) => Object.values(k.versions))).toEqual([
      ['DESTROY_SCHEDULED'],
    ]);
    expect(result.out).toContain('destroys for good: every sealed bundle');
  });

  it('keep my data refuses --delete-backups and --destroy-key', async () => {
    await install();
    const result = await teardown(['--keep-data', '--destroy-key', '--confirm', DOMAIN]);
    expect(result.status).toBe(1);
    expect(result.out).toContain('go with --remove-everything only');
  });

  it('refuses a VM whose labels changed after listing, reports it, and leaves the identity behind it', async () => {
    await install();
    // Between the listing and the delete, sam-node-a is relabelled to another install: the
    // re-check at the delete boundary must refuse it.
    const id = installationId();
    writeFileSync(
      join(bin, 'gcloud'),
      `#!/usr/bin/env bash
if [ "$1 $2 $3" = "compute instances describe" ] && [ "$4" = "sam-node-a" ]; then
  node -e 'const f=process.env.STATE+"/gcp.json";const fs=require("fs");const db=JSON.parse(fs.readFileSync(f));for(const i of db.instances){if(i.name==="sam-node-a")i.labels.installation="${OTHER_INSTALL}"}fs.writeFileSync(f,JSON.stringify(db))'
fi
exec node ${JSON.stringify(resolve(import.meta.dirname, 'testdata/fake-gcloud-iam.mjs'))} "$@"
`
    );
    const result = await teardown(['--keep-data', '--confirm', DOMAIN]);
    expect(result.status).toBe(1);
    expect(
      gcp()
        .instances.map((i) => i.name)
        .sort()
    ).toEqual(['sam-node-a', 'sam-node-other']);
    expect(result.out).toMatch(
      /Failed:[\s\S]*sam-node-a[^\n]*refused: sam-node-a labelled installation=f{32}/
    );
    // Step 3 never ran: the identity that could still delete VMs is kept.
    expect(result.out).toMatch(/Not attempted[\s\S]*workload-identity-pool/);
    expect(Object.keys(gcp().pools)).toHaveLength(1);
    expect(id).not.toBe(OTHER_INSTALL);
  });

  it('a second run after an injected failure completes the removal', async () => {
    await install();
    writeFileSync(join(fake, 'fail-once'), 'instances delete sam-node-b');
    const first = await teardown(['--remove-everything', '--confirm', DOMAIN]);
    expect(first.status).toBe(1);
    expect(first.out).toMatch(/Failed:[\s\S]*sam-node-b[^\n]*injected failure/);
    expect(first.out).toMatch(/Not attempted[\s\S]*every object under gs:\/\/fleet\/celld/);
    expect(existsSync(envFile)).toBe(true);
    expect(
      gcp()
        .instances.map((i) => i.name)
        .sort()
    ).toEqual(['sam-node-b', 'sam-node-other']);

    const second = await teardown(['--remove-everything', '--confirm', DOMAIN]);
    expect(second.status, second.out).toBe(0);
    expect(gcp().instances.map((i) => i.name)).toEqual(['sam-node-other']);
    expect(Object.keys(gcp().objects)).toEqual(['gs://fleet/other/keep.txt']);
    expect(existsSync(envFile)).toBe(false);
    const removed = record()
      .resources.filter((r) => r.removedAt)
      .map((r) => r.kind);
    expect(removed).toEqual(
      expect.arrayContaining([
        'instance',
        'workload-identity-pool',
        'service-account',
        'bucket-contents',
        'state-dir',
        'env-file',
      ])
    );
  });

  it('an install from before the record: bootstrap resources are shown as discovered and removed only with --adopt-discovered', async () => {
    await install();
    // Forget what the bootstrap recorded, as on an install that predates the record.
    const file = join(state, 'created-resources.json');
    const kept = record().resources.filter((r) => r.cloud === 'box');
    writeFileSync(file, JSON.stringify({ format: 'sam-created-resources/1', resources: kept }));
    // A pool of another install with the derived name of nothing here, and our own by name.
    const inventory = await teardown(['--gcp-project', PROJECT]);
    expect(inventory.status, inventory.out).toBe(0);
    expect(inventory.out).toMatch(
      /workload-identity-pool [^\n]*description names https:\/\/api\.sam\.example\.com\) \[discovered, not recorded\]/
    );
    expect(inventory.out).toMatch(/service-account sam-nodes@[^\n]*\[discovered, not recorded\]/);

    const without = await teardown(['--keep-data', '--gcp-project', PROJECT, '--confirm', DOMAIN]);
    expect(without.status, without.out).toBe(0);
    expect(Object.keys(gcp().pools)).toHaveLength(1);

    const adopted = await teardown([
      '--keep-data',
      '--adopt-discovered',
      '--gcp-project',
      PROJECT,
      '--confirm',
      DOMAIN,
    ]);
    expect(adopted.status, adopted.out).toBe(0);
    expect(Object.keys(gcp().pools)).toEqual([]);
    expect(Object.keys(gcp().accounts)).toEqual([]);
    expect(Object.keys(gcp().keys)).toHaveLength(1); // keep my data keeps the key
  });

  // Box round R5: on sam-box (bootstrap run from Cloud Shell, so no bootstrap record on the box;
  // gcloud on the box = the VM's own account) the inventory silently omitted the firewall rules and
  // the Cloud KMS key sealing the box, because "permission denied" was read as "does not exist".
  describe('the box VM account, with the bootstrap run elsewhere', () => {
    const DENY = '^(compute firewall-rules describe|kms keys describe|iam )';
    async function sealedWithCloudKms(): Promise<string> {
      await install();
      const key = record().resources.find((r) => r.kind === 'kms-key')!.name;
      const kept = record().resources.filter((r) => r.cloud === 'box');
      writeFileSync(
        join(state, 'created-resources.json'),
        JSON.stringify({ format: 'sam-created-resources/1', resources: kept })
      );
      mkdirSync(join(state, 'key-agent'), { recursive: true });
      writeFileSync(
        join(state, 'key-agent', 'choice.json'),
        JSON.stringify({ provider: 'gcp-kms', settings: { SAM_GCP_KMS_KEY: key } })
      );
      return key;
    }

    it('lists what it could not check and the KMS key that seals the box', async () => {
      const key = await sealedWithCloudKms();
      const before = snapshot();
      const inventory = await teardown(['--gcp-project', PROJECT], { FAKE_GCLOUD_DENY: DENY });
      expect(inventory.status, inventory.out).toBe(0);
      for (const rule of ['sam-allow-agent', 'sam-allow-app-routes']) {
        expect(inventory.out).toContain(
          `firewall rule ${rule} (${PROJECT}): could not check (ERROR: (gcloud.compute.firewall-rules.describe) PERMISSION_DENIED`
        );
      }
      expect(inventory.out).toMatch(
        /could not check workload identity pool sam-[0-9a-f]{8}, service account sam-nodes@[^,]+, KMS key sam-selfhost\/sam-[0-9a-f]{8} \(ERROR/
      );
      expect(inventory.out).toContain(`the Cloud KMS key ${key} that seals this box`);
      const dry = await teardown(['--remove-everything', '--dry-run', '--gcp-project', PROJECT], {
        FAKE_GCLOUD_DENY: DENY,
      });
      expect(dry.status, dry.out).toBe(0);
      expect(dry.out).toMatch(
        new RegExp(
          `Cloud KMS key ${key.replace(/[/.]/g, '\\$&')} [^\n]*: kept \\(pass --destroy-key`
        )
      );
      expect(dry.out).toMatch(
        /firewall rule sam-allow-agent [^\n]*could not check[^\n]*: left for you/
      );
      expect(snapshot()).toBe(before);
    });

    it('control: an account that can look finds the key once and reports nothing unchecked', async () => {
      const key = await sealedWithCloudKms();
      const inventory = await teardown(['--gcp-project', PROJECT]);
      expect(inventory.status, inventory.out).toBe(0);
      expect(inventory.out).toContain(`kms-key ${key} (labelled sam-install=`);
      expect(inventory.out).not.toContain('that seals this box');
      expect(inventory.out).not.toContain('could not check');
    });
  });

  // #2695 kept `-f docker-compose.yml` after #2696 moved every scripted compose call to the
  // COMPOSE_FILE list (an explicit -f drops the guided-login override; R4 bug 1).
  it('runs compose with every file COMPOSE_FILE lists', async () => {
    await install();
    writeFileSync(
      envFile,
      `${readFileSync(envFile, 'utf8')}COMPOSE_FILE=docker-compose.yml:docker-compose.guided-login.yml\n`,
      { mode: 0o600 }
    );
    const inventory = await teardown([]);
    expect(inventory.status, inventory.out).toBe(0);
    expect(inventory.out).toMatch(
      /docker compose -f \S+\/docker-compose\.yml -f \S+\/docker-compose\.guided-login\.yml --env-file/
    );
  });

  it('says so when no node VM in the project is labelled for SAM', async () => {
    await install();
    setGcp((db) => {
      db.instances = [];
    });
    const inventory = await teardown(['--gcp-project', PROJECT]);
    expect(inventory.status, inventory.out).toBe(0);
    expect(inventory.out).toContain(
      `node VMs in ${PROJECT}: none labelled managed=simple-agent-manager`
    );
  });

  it('leaves an un-prefixed bucket you brought to you instead of emptying it (security review H1)', async () => {
    writeFileSync(
      envFile,
      readFileSync(envFile, 'utf8').replace(
        'CELLD_BUCKET=gs://fleet/celld',
        'CELLD_BUCKET=gs://fleet'
      ),
      { mode: 0o600 }
    );
    await install();
    const result = await teardown(['--remove-everything', '--confirm', DOMAIN]);
    expect(result.status, result.out).toBe(0);
    expect(Object.keys(gcp().objects)).toHaveLength(4);
    expect(result.out).toMatch(
      /Left for you:[\s\S]*every object under gs:\/\/fleet[^\n]*no SAM prefix/
    );
    expect(lines('calls').filter((c) => c.startsWith('storage rm'))).toEqual([]);
  });

  it('refuses every VM when the record names two installation ids (security review M2)', async () => {
    await install();
    const added = spawnSync(
      'node',
      [
        resolve(import.meta.dirname, '../../deploy/selfhost/created-resources.mjs'),
        'add',
        join(state, 'created-resources.json'),
        'box',
        'installation',
        OTHER_INSTALL,
        'created',
        'deploy',
        `domain=${DOMAIN}`,
      ],
      { encoding: 'utf8' }
    );
    expect(added.status, added.stderr).toBe(0);
    const result = await teardown(['--keep-data', '--confirm', DOMAIN]);
    expect(result.status, result.out).toBe(0);
    expect(result.out).toContain(
      'node VMs will not be touched: the record names 2 installation ids'
    );
    expect(gcp().instances).toHaveLength(3);
  });

  it('refuses a recorded backup path whose manifest is not a backup manifest (security review M3)', async () => {
    await install();
    const odd = join(dir, 'not-a-backup');
    mkdirSync(odd);
    writeFileSync(join(odd, 'backup-manifest.json'), '{}');
    recordBackup(state, odd);
    const result = await teardown(['--remove-everything', '--delete-backups', '--confirm', DOMAIN]);
    expect(result.status, result.out).toBe(0);
    expect(existsSync(odd)).toBe(true);
    expect(existsSync(join(dir, 'backups', '2026-11-12T00-00-00Z'))).toBe(false);
    expect(result.out).toMatch(/Refused \(ownership not proven\):[\s\S]*not-a-backup/);
  });
});
