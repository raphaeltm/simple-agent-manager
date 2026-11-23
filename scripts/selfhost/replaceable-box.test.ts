/**
 * A replaceable box (replaceable-box.ts, replaceable-rebuild.ts): the bundles and the cloud record
 * reach the fleet bucket through the real `deploy.ts --init`, a new box rebuilt from the bucket
 * alone gets the same installation and keys back, and every way to lose the secrets with the box
 * (the key file, plaintext, the bundled store, sealing on an empty replacement) is refused.
 *
 * Cloud KMS is the fake from fixtures/key-provider-fakes.ts; the bucket is a directory served by a
 * fake `gcloud storage` (testdata/fake-gcloud-objects.mjs) on PATH, for the deploy and for rebuild.
 */
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { addResource } from '../../deploy/selfhost/created-resources.mjs';
import { openBundle, parseBundle, sealSecrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import { openBundleStore } from '../../deploy/selfhost/key-agent/bundle-store.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { runCommand } from './backup-cli.js';
import { loadBoxEnv } from './box-settings.js';
import {
  CHILD_TEST_TIMEOUT_MS,
  CLOSED_HOST,
  noStackDocker,
  runDeploy,
  writeBox,
} from './deploy-harness.js';
import { type FakeKeyService, startFakeKeyServices } from './fixtures/key-provider-fakes.js';
import { readInstallRecord, recordPath } from './install-record.js';
import { keyServiceSettings } from './key-service.js';
import {
  assertReplaceableSetup,
  type BoxBucket,
  fleetBucket,
  LEDGER_KEY,
  mirroredBundleStore,
  reconcileBundleMirror,
  replaceableBox,
} from './replaceable-box.js';
import { runRebuild } from './replaceable-rebuild.js';
import { stateInstallationId } from './state-installation.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

const GCP_KEY = 'projects/sam-fake-project/locations/global/keyRings/sam-selfhost/cryptoKeys/box';
const OTHER_KEY = 'projects/sam-fake-project/locations/global/keyRings/sam-selfhost/cryptoKeys/x';
const BUCKET = 'gs://fleet/celld';

let dir: string;
let fake: FakeKeyService;
let gcsRoot: string;
let env: NodeJS.ProcessEnv;

/** The fake `gcloud` on PATH; FAKE_GCS_ROOT is the bucket's directory. */
function withFakeGcloud(): NodeJS.ProcessEnv {
  const bin = join(dir, 'gcloud-bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(import.meta.dirname, 'testdata/fake-gcloud-objects.mjs'), join(bin, 'gcloud'));
  chmodSync(join(bin, 'gcloud'), 0o755);
  return { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GCS_ROOT: gcsRoot };
}

/** A second deploy finds an install: the no-stack docker and the fake gcloud, both on PATH. */
function existingInstallEnv(envFile: string): NodeJS.ProcessEnv {
  const noStack = noStackDocker(dirname(envFile));
  return { ...env, PATH: `${noStack.PATH?.split(':')[0]}:${env.PATH}` };
}

/** The bucket as rebuild and the assertions see it: the same fake gcloud, in process. */
function bucket(box: Readonly<Record<string, string>>): BoxBucket {
  return fleetBucket(box, (command, args) =>
    runCommand(command, args, { ...process.env, ...env, PATH: env.PATH })
  );
}

function boxEnv(stateDir: string, extra: string[] = []): string {
  const boxDir = dirname(stateDir);
  mkdirSync(boxDir, { recursive: true });
  return writeBox(boxDir, [
    `SAM_GCE_METADATA_HOST=${fake.host}`,
    `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
    `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
    `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
    'SAM_KEY_PROVIDER=gcp-kms',
    `SAM_GCP_KMS_KEY=${GCP_KEY}`,
    'SAM_REPLACEABLE_BOX=true',
    'COMPOSE_PROFILES=tunnel',
    `CELLD_BUCKET=${BUCKET}`,
    'GCE_METADATA_PROXY=off',
    ...extra,
  ]);
}

const boxOf = (envFile: string) => loadBoxEnv(envFile, dirname(envFile), {});
const bucketFiles = (prefix: string) => {
  const d = join(gcsRoot, 'fleet/celld', prefix);
  return existsSync(d) ? readdirSync(d).sort() : [];
};
const localBundles = (state: string) =>
  existsSync(join(state, 'key-agent/bundles'))
    ? readdirSync(join(state, 'key-agent/bundles'))
        .filter((n) => n.endsWith('.json'))
        .sort()
    : [];

async function newestSecrets(state: string, box: Readonly<Record<string, string>>) {
  const settings = keyServiceSettings(box, state);
  if (!settings) throw new Error('not sealed');
  const store = openBundleStore({ dir: join(state, 'key-agent/bundles') });
  const bundles = await Promise.all(
    (await store.listIds()).map(async (id) => parseBundle((await store.read(id)) ?? ''))
  );
  bundles.sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  return openBundle(bundles[0]!, createKeyProvider(settings.hostEnv));
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sam-replaceable-'));
  gcsRoot = join(dir, 'gcs');
  mkdirSync(join(gcsRoot, 'fleet/celld'), { recursive: true });
  fake = await startFakeKeyServices({ gcpProject: 'sam-fake-project' });
  env = withFakeGcloud();
});
afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('SAM_REPLACEABLE_BOX settings', () => {
  it('parses only true/false and refuses keys and buckets that die with the box', () => {
    expect(replaceableBox({})).toBe(false);
    expect(replaceableBox({ SAM_REPLACEABLE_BOX: 'false' })).toBe(false);
    expect(replaceableBox({ SAM_REPLACEABLE_BOX: 'true' })).toBe(true);
    expect(() => replaceableBox({ SAM_REPLACEABLE_BOX: 'yes' })).toThrow(/true or false/);
    const on = { SAM_REPLACEABLE_BOX: 'true', CELLD_BUCKET: BUCKET };
    expect(() => assertReplaceableSetup(on, 'file')).toThrow(/key file dies with the box/);
    expect(() => assertReplaceableSetup(on, 'legacy-plaintext')).toThrow(/plaintext/);
    expect(() =>
      assertReplaceableSetup({ ...on, COMPOSE_PROFILES: 'tunnel,local-store' }, 'gcp-kms')
    ).toThrow(/bundled store/);
    // Liveness: an off-box key and bucket pass; the mode off refuses nothing.
    for (const provider of ['gcp-kms', 'aws-kms', 'azure-kv', 'transit']) {
      expect(() => assertReplaceableSetup(on, provider)).not.toThrow();
    }
    expect(() => assertReplaceableSetup({}, 'file')).not.toThrow();
  });
});

describe('the bucket copy of the bundles', () => {
  /** An in-memory bucket, for the store and reconcile rules alone. */
  function memoryBucket(): BoxBucket & { objects: Map<string, string> } {
    const objects = new Map<string, string>();
    return {
      objects,
      list: (prefix) => [...objects.keys()].filter((k) => k.startsWith(prefix)),
      read: (key) => {
        const text = objects.get(key);
        if (text === undefined) throw new Error(`no ${key}`);
        return text;
      },
      write: (key, text) => void objects.set(key, text),
      remove: (keys) => keys.forEach((k) => objects.delete(k)),
    };
  }
  async function sealed(provider: ReturnType<typeof createKeyProvider>, at: string) {
    return sealSecrets({ SAM_INSTALLATION_ID: 'a'.repeat(32) }, provider, {
      installationId: 'a'.repeat(32),
      now: () => new Date(at),
    });
  }
  const fileProvider = () => {
    const keyFile = join(dir, 'kek');
    writeFileSync(keyFile, `${Buffer.alloc(32, 7).toString('base64')}\n`, { mode: 0o600 });
    return createKeyProvider({ SAM_KEY_PROVIDER: 'file', SAM_KEY_FILE: keyFile });
  };

  it('writes and removes every bundle in both places', async () => {
    const remote = memoryBucket();
    const local = openBundleStore({ dir: join(dir, 'bundles') });
    const store = mirroredBundleStore(local, remote);
    const bundle = await sealed(fileProvider(), '2026-11-01T00:00:00Z');
    await store.write(bundle);
    const key = `sam-box/bundles/${bundle.bundleId}.json`;
    expect(remote.objects.get(key)).toBe(await local.read(bundle.bundleId));
    await store.remove(bundle.bundleId);
    expect(remote.objects.has(key)).toBe(false);
    expect(await local.read(bundle.bundleId)).toBeNull();
  });

  it('uploads what is missing, drops what the box pruned, and stops on what it never had', async () => {
    const provider = fileProvider();
    const remote = memoryBucket();
    const local = openBundleStore({ dir: join(dir, 'bundles') });
    const [old, current, newer] = [
      await sealed(provider, '2026-11-01T00:00:00Z'),
      await sealed(provider, '2026-11-02T00:00:00Z'),
      await sealed(provider, '2026-11-03T00:00:00Z'),
    ];
    // An empty box and a bucket with bundles: a replacement that skipped rebuild.
    remote.write(`sam-box/bundles/${old!.bundleId}.json`, JSON.stringify(old));
    await expect(reconcileBundleMirror(local, remote, () => undefined)).rejects.toThrow(
      /replacement box\. Run pnpm selfhost:rebuild/
    );
    // The box has a newer bundle: the older remote one was pruned, the local one goes up.
    await local.write(current!);
    await reconcileBundleMirror(local, remote, () => undefined);
    expect(remote.list('sam-box/bundles/')).toEqual([`sam-box/bundles/${current!.bundleId}.json`]);
    // A newer bundle only the bucket has: another box, or a stale copy of this one.
    remote.write(`sam-box/bundles/${newer!.bundleId}.json`, JSON.stringify(newer));
    await expect(reconcileBundleMirror(local, remote, () => undefined)).rejects.toThrow(
      /newer than any on this box/
    );
    expect(remote.objects.has(`sam-box/bundles/${newer!.bundleId}.json`)).toBe(true);
  });

  it('never prunes or seals over another installation, on every sealing path', async () => {
    const provider = fileProvider();
    const remote = memoryBucket();
    const local = openBundleStore({ dir: join(dir, 'bundles') });
    const ours = await sealed(provider, '2026-11-05T00:00:00Z');
    await local.write(ours);
    // An OLDER bundle of another installation: by date alone it would be "pruned".
    const theirs = await sealSecrets({ SAM_INSTALLATION_ID: 'b'.repeat(32) }, provider, {
      installationId: 'b'.repeat(32),
      now: () => new Date('2026-11-01T00:00:00Z'),
    });
    remote.write(`sam-box/bundles/${theirs.bundleId}.json`, JSON.stringify(theirs));
    await expect(reconcileBundleMirror(local, remote, () => undefined)).rejects.toThrow(
      /of installation b{32}, not this box's a{32}/
    );
    expect(remote.objects.has(`sam-box/bundles/${theirs.bundleId}.json`)).toBe(true);
    // secrets switch / rotate seal through the mirrored store without reconcile: an empty
    // replacement box is refused there too, before anything is written.
    const empty = openBundleStore({ dir: join(dir, 'empty-bundles') });
    await expect(mirroredBundleStore(empty, remote).write(ours)).rejects.toThrow(/replacement box/);
    expect(await empty.listIds()).toEqual([]);
  });
});

describe('replace a dead box (real deploy --init, fake Cloud KMS and bucket)', () => {
  it('rebuilds the same installation and keys on an empty box from the bucket alone', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    const init = await runDeploy(envA, ['--init'], env);
    expect(init.status, init.out).toBe(0);
    const boxA = boxOf(envA);
    const before = await newestSecrets(stateA, boxA);
    // A GCP bootstrap entry (gcp-bootstrap.sh writes these), then a deploy seals the record.
    addResource(recordPath(stateA), {
      cloud: 'gcp',
      kind: 'workload-identity-pool',
      name: 'sam-pool-1',
      action: 'created',
      createdBy: 'gcp-bootstrap',
      attributes: { project: 'sam-nodes' },
    });
    const again = await runDeploy(envA, ['--init'], existingInstallEnv(envA));
    expect(again.status, again.out).toBe(0);
    expect(bucketFiles('sam-box/bundles')).toEqual(localBundles(stateA));
    expect(bucketFiles('sam-box')).toContain('ledger.json');
    // Ciphertext only: no secret value of the box appears in the bucket copy.
    const copied = readFileSync(join(gcsRoot, 'fleet/celld', LEDGER_KEY), 'utf8');
    expect(copied).not.toContain('sam-pool-1');
    for (const name of bucketFiles('sam-box/bundles')) {
      const text = readFileSync(join(gcsRoot, 'fleet/celld/sam-box/bundles', name), 'utf8');
      expect(text).not.toContain(before.ENCRYPTION_KEY!);
    }

    // The box dies: a new VM has the same .env and an empty state directory.
    const stateB = join(dir, 'box-b/.state');
    const envB = boxEnv(stateB);
    const boxB = boxOf(envB);
    // --init before rebuild would make new keys: refused.
    const premature = await runDeploy(envB, ['--init'], env);
    expect(premature.status).not.toBe(0);
    expect(premature.out).toMatch(/replacement box\. Run pnpm selfhost:rebuild/);
    expect(localBundles(stateB)).toEqual([]);
    rmSync(stateB, { recursive: true, force: true });

    const logs: string[] = [];
    const result = await runRebuild({
      box: boxB,
      stateDir: stateB,
      bucket: bucket(boxB),
      detect: async () => ({ platform: null, candidates: [] }),
      log: (m) => logs.push(m),
    });
    expect(result.installationId).toBe(before.SAM_INSTALLATION_ID);
    expect(localBundles(stateB)).toEqual(localBundles(stateA));
    expect(
      readInstallRecord(stateB)
        .filter((r) => r.cloud === 'gcp')
        .map((r) => r.name)
    ).toEqual(['sam-pool-1']);

    // --init on the rebuilt box keeps every key: same installation, nothing generated.
    const rebuilt = await runDeploy(envB, ['--init'], existingInstallEnv(envB));
    expect(rebuilt.status, rebuilt.out).toBe(0);
    expect(rebuilt.out).not.toMatch(/generated platform keys/);
    expect(stateInstallationId(stateB)).toBe(before.SAM_INSTALLATION_ID);
    const after = await newestSecrets(stateB, boxB);
    for (const name of ['ENCRYPTION_KEY', 'JWT_PRIVATE_KEY', 'REVERSE_TUNNEL_GATEWAY_SECRET']) {
      expect(after[name], name).toBe(before[name]);
    }
  });

  it('refuses bundles the configured key did not seal, and a non-empty state', async () => {
    const stateA = join(dir, 'box-a/.state');
    const init = await runDeploy(boxEnv(stateA), ['--init'], env);
    expect(init.status, init.out).toBe(0);
    const stateB = join(dir, 'box-b/.state');
    // .env names another key than the one the bundles were sealed with.
    const other = boxOf(boxEnv(stateB, [`SAM_GCP_KMS_KEY=${OTHER_KEY}`]));
    const input = (box: Readonly<Record<string, string>>) => ({
      box,
      stateDir: stateB,
      bucket: bucket(box),
      detect: async () => ({ platform: null, candidates: [] }),
      log: () => undefined,
    });
    await expect(runRebuild(input(other))).rejects.toThrow(/does not resolve to/);
    // A forged bundle under the right key name: a different key service sealed it.
    const forger = await startFakeKeyServices({ gcpProject: 'sam-fake-project' });
    try {
      const box = boxOf(boxEnv(stateB));
      const settings = keyServiceSettings(
        {
          ...box,
          SAM_GCP_KMS_ENDPOINT: `http://${forger.host}`,
          SAM_GCE_METADATA_HOST: forger.host,
        },
        stateB
      )!;
      const forged = await sealSecrets(
        { SAM_INSTALLATION_ID: stateInstallationId(stateA) },
        createKeyProvider(settings.hostEnv),
        { installationId: stateInstallationId(stateA), now: () => new Date('2999-01-01T00:00:00Z') }
      );
      writeFileSync(
        join(gcsRoot, 'fleet/celld/sam-box/bundles', `${forged.bundleId}.json`),
        JSON.stringify(forged)
      );
      await expect(runRebuild(input(box))).rejects.toThrow();
      expect(localBundles(stateB)).toEqual([]);
      rmSync(join(gcsRoot, 'fleet/celld/sam-box/bundles', `${forged.bundleId}.json`));
      // The operator's installation id pins the rebuild: another id is refused.
      await expect(
        runRebuild({ ...input(box), expectedInstallationId: 'f'.repeat(32) })
      ).rejects.toThrow(/not f{32}/);
      // Control: without the forgery the same rebuild succeeds (pinned to the right id).
      await runRebuild({ ...input(box), expectedInstallationId: stateInstallationId(stateA) });
      expect(localBundles(stateB)).toEqual(localBundles(stateA));
      // Running it again completes or repeats it (a rebuild that stopped part way)...
      await runRebuild(input(box));
      expect(localBundles(stateB)).toEqual(localBundles(stateA));
      // ...but a state holding a bundle the bucket does not have is another install: refused.
      const foreign = await sealSecrets(
        { SAM_INSTALLATION_ID: 'e'.repeat(32) },
        createKeyProvider(keyServiceSettings(box, stateB)!.hostEnv),
        { installationId: 'e'.repeat(32) }
      );
      await openBundleStore({ dir: join(stateB, 'key-agent/bundles') }).write(foreign);
      await expect(runRebuild(input(box))).rejects.toThrow(/already holds an install/);
    } finally {
      await forger.close();
    }
  });

  it('works with the automatic key choice, and warns when the ledger is missing', async () => {
    const stateA = join(dir, 'box-a/.state');
    // No SAM_KEY_PROVIDER: --init chooses the cloud key itself and records the choice.
    const envA = boxEnv(stateA, ['SAM_KEY_PROVIDER=']);
    const init = await runDeploy(envA, ['--init'], env);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toMatch(/key provider: gcp-kms/);
    // A plain deploy reads the recorded choice (not .env) and still reconciles and publishes.
    rmSync(join(gcsRoot, 'fleet/celld/sam-box/ledger.json'));
    const again = await runDeploy(envA, ['--init'], existingInstallEnv(envA));
    expect(again.status, again.out).toBe(0);
    expect(bucketFiles('sam-box')).toContain('ledger.json');
    expect(bucketFiles('sam-box/bundles')).toEqual(localBundles(stateA));
    // Rebuild with the automatic candidates; the ledger deleted: it says so.
    rmSync(join(gcsRoot, 'fleet/celld/sam-box/ledger.json'));
    const stateB = join(dir, 'box-b/.state');
    const boxB = boxOf(boxEnv(stateB, ['SAM_KEY_PROVIDER=']));
    const logs: string[] = [];
    await runRebuild({
      box: boxB,
      stateDir: stateB,
      bucket: bucket(boxB),
      detect: async () => ({
        platform: 'Google Cloud (project sam-fake-project)',
        candidates: [
          { provider: 'gcp-kms', settings: { SAM_GCP_KMS_KEY: GCP_KEY }, label: GCP_KEY },
        ],
      }),
      log: (m) => logs.push(m),
    });
    expect(localBundles(stateB)).toEqual(localBundles(stateA));
    expect(logs.join('\n')).toMatch(/WARNING: the fleet bucket holds no sam-box\/ledger\.json/);
  });

  it('refuses replaceable mode with the key file, explicit or automatic', async () => {
    const explicit = await runDeploy(
      boxEnv(join(dir, 'f1/.state'), ['SAM_KEY_PROVIDER=file']),
      ['--init'],
      env
    );
    expect(explicit.status).not.toBe(0);
    expect(explicit.out).toMatch(/key file dies with the box/);
    // Automatic choice with no cloud key reachable would fall back to the key file: refused.
    const auto = await runDeploy(
      boxEnv(join(dir, 'f2/.state'), [
        'SAM_KEY_PROVIDER=',
        `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
        'SAM_GCP_KMS_KEY=',
      ]),
      ['--init'],
      env
    );
    expect(auto.status).not.toBe(0);
    expect(auto.out).toMatch(
      /SAM_REPLACEABLE_BOX=true needs a key held off this box, and none is usable/
    );
    // Refused before the choice is recorded: a later run does not inherit a key-file choice.
    expect(existsSync(join(dir, 'f2/.state/key-agent/choice.json'))).toBe(false);
    expect(existsSync(join(dir, 'f2/.state/key-agent/kek'))).toBe(false);
    expect(bucketFiles('sam-box/bundles')).toEqual([]);
  });
});
