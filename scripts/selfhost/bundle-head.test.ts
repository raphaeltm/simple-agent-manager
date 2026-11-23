/**
 * The bundle head (bundle-head.ts): which sealed bundle is current, recorded at every seal, so a
 * host clock that moves backwards cannot make a deploy, a rotation or a rebuild pick an older
 * bundle (ideas 01M83X8B5QEZYW056030YGWCG6, 01M7W2QMJ4MFVXT4Q06DCAWP1K).
 *
 * Every case runs the real `deploy.ts` (a child process, its clock shifted by
 * testdata/clock-offset.mjs) on a replaceable box: Cloud KMS is the fake from
 * fixtures/key-provider-fakes.ts and the fleet bucket a directory behind a fake `gcloud storage`.
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

import {
  openBundle,
  parseBundle,
  type SealedBundle,
  sealSecrets,
} from '../../deploy/selfhost/key-agent/bundle.ts';
import { createKeyProvider } from '../../deploy/selfhost/key-agent/providers.ts';
import { runCommand } from './backup-cli.js';
import { loadBoxEnv } from './box-settings.js';
import { commitHead, headHint, sealHead } from './bundle-head.js';
import {
  CHILD_TEST_TIMEOUT_MS,
  CLOSED_HOST,
  noStackDocker,
  runDeploy,
  writeBox,
} from './deploy-harness.js';
import { type FakeKeyService, startFakeKeyServices } from './fixtures/key-provider-fakes.js';
import { keyServiceSettings } from './key-service.js';
import { type BoxBucket, fleetBucket, HEAD_KEY } from './replaceable-box.js';
import { runRebuild } from './replaceable-rebuild.js';
import { applyPatch, type RotateDeps, type StepContext } from './rotate-apply.js';
import { type Journal, openRotationStore } from './rotate-store.js';
import { type MigrateDeps, runMigration } from './secrets-migrate.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS * 2 });

const GCP_KEY = 'projects/sam-fake-project/locations/global/keyRings/sam-selfhost/cryptoKeys/box';
const BUCKET = 'gs://fleet/celld';
const HOUR_MS = 3_600_000;
const CLOCK = join(import.meta.dirname, 'testdata/clock-offset.mjs');

let dir: string;
let fake: FakeKeyService;
let gcsRoot: string;
let env: NodeJS.ProcessEnv;

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sam-bundle-head-'));
  gcsRoot = join(dir, 'gcs');
  mkdirSync(join(gcsRoot, 'fleet/celld'), { recursive: true });
  fake = await startFakeKeyServices({ gcpProject: 'sam-fake-project' });
  const bin = join(dir, 'gcloud-bin');
  mkdirSync(bin, { recursive: true });
  copyFileSync(join(import.meta.dirname, 'testdata/fake-gcloud-objects.mjs'), join(bin, 'gcloud'));
  chmodSync(join(bin, 'gcloud'), 0o755);
  env = { PATH: `${bin}:${process.env.PATH ?? ''}`, FAKE_GCS_ROOT: gcsRoot };
});
afterEach(async () => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

function boxEnv(stateDir: string): string {
  mkdirSync(dirname(stateDir), { recursive: true });
  return writeBox(dirname(stateDir), [
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
  ]);
}

const boxOf = (envFile: string) => loadBoxEnv(envFile, dirname(envFile), {});

/** The deploy's environment once the box is installed, its clock shifted by `offsetMs`. */
function deployEnv(envFile: string, offsetMs = 0): NodeJS.ProcessEnv {
  const noStack = noStackDocker(dirname(envFile));
  return {
    ...env,
    PATH: `${noStack.PATH?.split(':')[0]}:${env.PATH}`,
    NODE_OPTIONS: `--import=${CLOCK}`,
    SAM_TEST_CLOCK_OFFSET_MS: String(offsetMs),
  };
}

async function deploy(envFile: string, args: string[], offsetMs = 0) {
  // `--init` on an installed box keeps its installation and keys, and stops before celld (as in
  // replaceable-box.test.ts); the dry run is what names the bundle.
  const base = args.includes('--dry-run') || args.includes('--init') ? args : ['--init', ...args];
  const all = [...base, '--skip-vm-agent'];
  const result = await runDeploy(envFile, all, deployEnv(envFile, offsetMs));
  expect(result.status, result.out).toBe(0);
  return result.out;
}

/** The bundle id a deploy names (the Worker var it renders), read from a dry run. */
async function namedBundle(envFile: string): Promise<string> {
  const out = await deploy(envFile, ['--dry-run']);
  const match = /"SAM_SECRET_BUNDLE_ID": "([0-9a-f]{32})"/.exec(out);
  if (!match) throw new Error(`no bundle id in the dry run:\n${out}`);
  return match[1] as string;
}

function bucket(box: Readonly<Record<string, string>>): BoxBucket {
  return fleetBucket(box, (command, args) =>
    runCommand(command, args, { ...process.env, ...env, PATH: env.PATH })
  );
}

const bundleDir = (state: string) => join(state, 'key-agent/bundles');
const headPath = (state: string) => join(state, 'key-agent/head.json');
const bucketHeadPath = () => join(gcsRoot, 'fleet/celld', HEAD_KEY);

function bundlesOn(state: string): SealedBundle[] {
  return readdirSync(bundleDir(state))
    .filter((n) => /^[0-9a-f]{32}\.json$/.test(n))
    .map((n) => parseBundle(readFileSync(join(bundleDir(state), n), 'utf8')));
}

function providerOf(state: string, envFile: string) {
  const settings = keyServiceSettings(boxOf(envFile), state);
  if (!settings) throw new Error('not sealed');
  return createKeyProvider(settings.hostEnv);
}

function writeSecrets(state: string, lines: string[]): void {
  mkdirSync(state, { recursive: true });
  writeFileSync(join(state, 'secrets.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

/**
 * Seal at T with OPERATOR_TOKEN, then remove it with `--unset` while the clock is an hour behind:
 * the bundle without the value is dated BEFORE the one with it.
 */
async function sealThenRollClockBack(state: string, envFile: string) {
  writeSecrets(state, ['OPERATOR_TOKEN=operator-token-0123456789']);
  await deploy(envFile, ['--init']);
  const [withValue] = bundlesOn(state);
  writeSecrets(state, []);
  await deploy(envFile, ['--unset', 'OPERATOR_TOKEN'], -HOUR_MS);
  const unset = bundlesOn(state).find((b) => b.bundleId !== withValue?.bundleId);
  if (!withValue || !unset) throw new Error('expected two bundles');
  // The clock really went backwards: by date, the bundle WITH the value is the newest.
  expect(unset.createdAt < withValue.createdAt).toBe(true);
  return { withValue, unset };
}

describe('a host clock that moved backwards between two seals', () => {
  it('the deploy names the bundle sealed last, and a rebuild from the bucket picks it too', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    const { withValue, unset } = await sealThenRollClockBack(stateA, envA);
    const provider = providerOf(stateA, envA);

    // The next deploy (clock back to normal) names the bundle sealed last, not the newest date.
    expect(await namedBundle(envA)).toBe(unset.bundleId);
    const out = await deploy(envA, []);
    expect(out).not.toMatch(/sealed \d+ secrets into bundle/);
    expect(
      bundlesOn(stateA)
        .map((b) => b.bundleId)
        .sort()
    ).toEqual([withValue.bundleId, unset.bundleId].sort());
    expect(headHint(readFileSync(headPath(stateA), 'utf8'))?.bundleId).toBe(unset.bundleId);
    expect(await openBundle(unset, provider)).not.toHaveProperty('OPERATOR_TOKEN');
    // The bucket holds the same head the box does.
    expect(readFileSync(bucketHeadPath(), 'utf8')).toBe(readFileSync(headPath(stateA), 'utf8'));

    // The box dies; a rebuild from the bucket restores the same current bundle and head.
    const stateB = join(dir, 'box-b/.state');
    const envB = boxEnv(stateB);
    const result = await runRebuild({
      box: boxOf(envB),
      stateDir: stateB,
      bucket: bucket(boxOf(envB)),
      detect: async () => ({ platform: null, candidates: [] }),
      log: () => undefined,
    });
    expect(result.bundleIds[0]).toBe(unset.bundleId);
    expect(readFileSync(headPath(stateB), 'utf8')).toBe(readFileSync(headPath(stateA), 'utf8'));
    expect(await namedBundle(envB)).toBe(unset.bundleId);
  });

  it('a rotation sealed while the clock is behind is what the next deploy runs', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    writeSecrets(stateA, []);
    await deploy(envA, ['--init']);
    // The rotation runs in this process: its bucket copy goes through the same fake gcloud.
    vi.stubEnv('PATH', env.PATH);
    vi.stubEnv('FAKE_GCS_ROOT', gcsRoot);
    const store = openRotationStore(boxOf(envA), stateA);
    const before = await store.head();
    const journal: Journal = {
      format: 'sam-key-rotation/1',
      id: 'r1',
      startedAt: new Date().toISOString(),
      backupDir: null,
      keys: ['test'],
      steps: { test: { name: 'test', phase: 'pending' } },
    };
    const deployed: string[] = [];
    const deps = {
      log: () => undefined,
      // The real deploy, after each seal: record which bundle it names.
      deploy: async () => void deployed.push(await namedBundle(envA)),
      adoptAndCheck: async () => ({ healthy: true, detail: '' }),
    } as unknown as RotateDeps;
    const ctx = (s: typeof store): StepContext => ({
      journal,
      step: journal.steps.test as StepContext['step'],
      key: { name: 'test' } as StepContext['key'],
      store: s,
      deps,
      stateDir: stateA,
      save: () => undefined,
    });
    // Sealed an hour in the past: by date it is older than the bundle it replaces.
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(Date.parse(before.bundle.createdAt) - HOUR_MS);
    await applyPatch(ctx(store), { set: { OPERATOR_TOKEN: 'rotated-0123456789' } }, 'switched');
    vi.useRealTimers();
    const rotated = await store.head();
    expect(rotated.bundle.createdAt < before.bundle.createdAt).toBe(true);
    expect(rotated.secrets.OPERATOR_TOKEN).toBe('rotated-0123456789');
    expect(deployed).toEqual([rotated.bundle.bundleId]);

    // Stopped after writing the next bundle but before making it current: resuming makes it
    // current and deploys it, instead of refusing or deploying the one before.
    const crashing = {
      ...store,
      write: async (bundle: SealedBundle) => {
        await store.settings.bundles.write(bundle);
        throw new Error('stopped');
      },
    };
    await expect(
      applyPatch(ctx(crashing), { set: { OPERATOR_TOKEN: 'second-0123456789' } }, 'done')
    ).rejects.toThrow(/stopped/);
    const staged = journal.steps.test?.stagedBundleId as string;
    expect((await store.head()).bundle.bundleId).toBe(rotated.bundle.bundleId);
    await applyPatch(ctx(store), { set: { OPERATOR_TOKEN: 'second-0123456789' } }, 'done');
    expect((await store.head()).bundle.bundleId).toBe(staged);
    expect(deployed.at(-1)).toBe(staged);
  });
});

describe('a head that is not genuine fails closed', () => {
  it('refuses a tampered or foreign head in the deploy, the reconcile and the rebuild', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    const { withValue, unset } = await sealThenRollClockBack(stateA, envA);
    const provider = providerOf(stateA, envA);
    const genuine = readFileSync(headPath(stateA), 'utf8');
    const refused = async (pattern: RegExp, args: string[] = ['--dry-run']) => {
      const all = args.includes('--dry-run') ? args : ['--init', ...args];
      const result = await runDeploy(envA, [...all, '--skip-vm-agent'], deployEnv(envA));
      expect(result.status, result.out).not.toBe(0);
      expect(result.out).toMatch(pattern);
    };

    // Its plaintext edited to name the older bundle (the one still holding the unset value).
    const edited = JSON.parse(genuine) as Record<string, unknown>;
    writeFileSync(headPath(stateA), JSON.stringify({ ...edited, bundleId: withValue.bundleId }));
    await refused(/edited after it was sealed/);
    // Its seal damaged.
    const seal = edited.seal as Record<string, string>;
    writeFileSync(
      headPath(stateA),
      JSON.stringify({ ...edited, seal: { ...seal, ciphertext: `A${seal.ciphertext.slice(1)}` } })
    );
    await refused(/does not open/);
    // A genuine head of another installation under the same key, naming this box's bundle.
    const foreign = await sealHead(
      { seq: 9, bundleId: unset.bundleId, installationId: 'b'.repeat(32) },
      provider
    );
    writeFileSync(headPath(stateA), foreign);
    await refused(/the head belongs to b{32}; refusing it/);
    // ...or naming its own bundle, which this box does not have.
    writeFileSync(
      headPath(stateA),
      await sealHead({ seq: 9, bundleId: 'c'.repeat(32), installationId: 'b'.repeat(32) }, provider)
    );
    await refused(/names bundle c{32}, which is not there/);
    // Control: the genuine head deploys.
    writeFileSync(headPath(stateA), genuine);
    expect(await namedBundle(envA)).toBe(unset.bundleId);

    // The bucket's head: a later write than the box's stops the deploy (box behind bucket), a
    // foreign one too, and a tampered one stops the reconcile and the rebuild.
    const local = headHint(genuine);
    writeFileSync(
      bucketHeadPath(),
      await sealHead(
        {
          seq: (local?.seq ?? 0) + 1,
          bundleId: withValue.bundleId,
          installationId: local?.installationId ?? '',
        },
        provider
      )
    );
    await refused(/a later seal than this box's/, []);
    writeFileSync(bucketHeadPath(), foreign);
    await refused(/belongs to installation b{32}/, []);
    const remoteTampered = JSON.stringify({ ...edited, bundleId: withValue.bundleId });
    writeFileSync(bucketHeadPath(), remoteTampered);
    await refused(/edited after it was sealed/, []);
    // Rotation (and switch) seal without the deploy's reconcile: they verify the bucket head
    // themselves, so neither an edited hint nor a genuine later head lets them seal over it.
    vi.stubEnv('PATH', env.PATH);
    vi.stubEnv('FAKE_GCS_ROOT', gcsRoot);
    const store = openRotationStore(boxOf(envA), stateA);
    const next = await store.seal((await store.head()).secrets);
    await expect(store.write(next)).rejects.toThrow(/edited after it was sealed/);
    writeFileSync(
      bucketHeadPath(),
      await sealHead(
        {
          seq: (local?.seq ?? 0) + 1,
          bundleId: withValue.bundleId,
          installationId: local?.installationId ?? '',
        },
        provider
      )
    );
    await expect(store.write(next)).rejects.toThrow(/a later seal than this box's/);
    expect(bundlesOn(stateA).map((b) => b.bundleId)).not.toContain(next.bundleId);
    // A seal that read the head before another one moved it does not overwrite it.
    writeFileSync(bucketHeadPath(), genuine);
    const stale = headHint(genuine);
    await store.write(next);
    await expect(commitHead(store.settings.bundles, withValue, provider, stale)).rejects.toThrow(
      /the current sealed bundle changed while/
    );
    expect(headHint(readFileSync(headPath(stateA), 'utf8'))?.bundleId).toBe(next.bundleId);
    writeFileSync(bucketHeadPath(), remoteTampered);
    const stateB = join(dir, 'box-b/.state');
    const envB = boxEnv(stateB);
    const rebuild = () =>
      runRebuild({
        box: boxOf(envB),
        stateDir: stateB,
        bucket: bucket(boxOf(envB)),
        detect: async () => ({ platform: null, candidates: [] }),
        log: () => undefined,
      });
    await expect(rebuild()).rejects.toThrow(/edited after it was sealed/);
    writeFileSync(bucketHeadPath(), foreign);
    await expect(rebuild()).rejects.toThrow(/the head belongs to b{32}/);
    expect(existsSync(headPath(stateB))).toBe(false);
    // Control: the box's genuine head (after the rotation's write) rebuilds.
    writeFileSync(bucketHeadPath(), readFileSync(headPath(stateA), 'utf8'));
    expect((await rebuild()).bundleIds[0]).toBe(next.bundleId);
  });
});

describe('a box from before the head', () => {
  it('deploys the newest bundle by date, as before, then records the head on both sides', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    const { withValue } = await sealThenRollClockBack(stateA, envA);
    // Without a head (the box and its bucket before this change) the date decides.
    rmSync(headPath(stateA));
    rmSync(bucketHeadPath());
    // A rebuild from a bucket without a head refuses (a deleted head looks the same) unless told
    // the dead box predates it; then the date decides, as the dead box's own deploy would have.
    const stateB = join(dir, 'box-b/.state');
    const envB = boxEnv(stateB);
    const rebuild = (allowNoHead: boolean) =>
      runRebuild({
        box: boxOf(envB),
        stateDir: stateB,
        bucket: bucket(boxOf(envB)),
        detect: async () => ({ platform: null, candidates: [] }),
        log: () => undefined,
        allowNoHead,
      });
    await expect(rebuild(false)).rejects.toThrow(/no sam-box\/head\.json.*--allow-no-head/s);
    expect(existsSync(bundleDir(stateB))).toBe(false);
    expect((await rebuild(true)).bundleIds[0]).toBe(withValue.bundleId);
    expect(await namedBundle(envA)).toBe(withValue.bundleId);
    expect(existsSync(headPath(stateA))).toBe(false); // a dry run writes nothing
    const out = await deploy(envA, []);
    expect(out).toContain(`recorded bundle ${withValue.bundleId} as the current sealed bundle`);
    expect(out).not.toMatch(/sealed \d+ secrets into bundle/);
    const head = readFileSync(headPath(stateA), 'utf8');
    expect(headHint(head)).toMatchObject({ seq: 1, bundleId: withValue.bundleId });
    expect(readFileSync(bucketHeadPath(), 'utf8')).toBe(head);
    // From now on the head decides: the same bundle, and nothing is written again.
    expect(await namedBundle(envA)).toBe(withValue.bundleId);
    expect(await deploy(envA, [])).not.toContain('recorded bundle');
  });
});

describe('a failed secrets migrate on a replaceable box', () => {
  it('undoes its head and bundles in the bucket too, so the next deploy is not stopped', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    mkdirSync(join(stateA, 'key-agent'), { recursive: true });
    // A box still on plaintext files (what migrate seals), with replaceable mode configured.
    writeFileSync(
      join(stateA, 'platform-keys.json'),
      JSON.stringify({ SAM_INSTALLATION_ID: 'a'.repeat(32) }),
      { mode: 0o600 }
    );
    vi.stubEnv('PATH', env.PATH);
    vi.stubEnv('FAKE_GCS_ROOT', gcsRoot);
    const box = boxOf(envA);
    const settings = keyServiceSettings(box, stateA);
    if (!settings) throw new Error('not sealed');
    const provider = createKeyProvider(settings.hostEnv);
    const deps = {
      log: () => undefined,
      // The --init writes through the store the deploy uses (mirrored to the bucket).
      init: async () => {
        const bundle = await sealSecrets({ SAM_INSTALLATION_ID: 'a'.repeat(32) }, provider, {
          installationId: 'a'.repeat(32),
        });
        await settings.bundles.write(bundle);
        await commitHead(settings.bundles, bundle, provider, null);
      },
      preflight: async () => {
        throw new Error('the Worker would not get these secrets unchanged');
      },
    } as unknown as MigrateDeps;
    await expect(runMigration({ box, stateDir: stateA }, deps)).rejects.toThrow(/unchanged/);
    expect(existsSync(headPath(stateA))).toBe(false);
    expect(existsSync(bucketHeadPath())).toBe(false);
    expect(
      existsSync(join(gcsRoot, 'fleet/celld/sam-box/bundles'))
        ? readdirSync(join(gcsRoot, 'fleet/celld/sam-box/bundles'))
        : []
    ).toEqual([]);
  });
});
