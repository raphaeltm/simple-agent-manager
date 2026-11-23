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
  renameSync,
  rmSync,
  statSync,
  utimesSync,
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
import {
  breakStaleLock,
  type BundleStore,
  joinLockFile,
  withLockFile,
} from '../../deploy/selfhost/key-agent/bundle-store.ts';
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
import { SEALING_LOCK_ENV, withSealingLock } from './sealing-lock.js';
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
 * Seal at T with OPERATOR_SETTING, then remove it with `--unset` while the clock is an hour behind:
 * the bundle without the value is dated BEFORE the one with it.
 */
async function sealThenRollClockBack(state: string, envFile: string) {
  writeSecrets(state, ['OPERATOR_SETTING=operator-value-one']);
  await deploy(envFile, ['--init']);
  const [withValue] = bundlesOn(state);
  writeSecrets(state, []);
  await deploy(envFile, ['--unset', 'OPERATOR_SETTING'], -HOUR_MS);
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
    expect(out).toContain(`note: bundle ${withValue.bundleId} is dated after the current one`);
    expect(
      bundlesOn(stateA)
        .map((b) => b.bundleId)
        .sort()
    ).toEqual([withValue.bundleId, unset.bundleId].sort());
    expect(headHint(readFileSync(headPath(stateA), 'utf8'))?.bundleId).toBe(unset.bundleId);
    expect(await openBundle(unset, provider)).not.toHaveProperty('OPERATOR_SETTING');
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
    // Two leftovers dated after the current bundle that the head does not name (sealed while the
    // clock ran ahead): ranked by date they would push the replaced bundle out of the prune.
    for (const year of [2030, 2031]) {
      await store.settings.bundles.write(
        await sealSecrets(before.secrets, store.provider, {
          installationId: before.bundle.installationId,
          now: () => new Date(`${year}-01-01T00:00:00Z`),
        })
      );
    }
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
    await applyPatch(ctx(store), { set: { OPERATOR_SETTING: 'rotated-value' } }, 'switched');
    vi.useRealTimers();
    const rotated = await store.head();
    expect(rotated.bundle.createdAt < before.bundle.createdAt).toBe(true);
    expect(rotated.secrets.OPERATOR_SETTING).toBe('rotated-value');
    expect(deployed).toEqual([rotated.bundle.bundleId]);
    // The bundle the rotation replaced is kept by name: the previous Worker version asks for it.
    expect(bundlesOn(stateA).map((b) => b.bundleId)).toContain(before.bundle.bundleId);
    // ...within the box's limit: it takes one of the three places, not a fourth.
    expect(bundlesOn(stateA)).toHaveLength(3);

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
      applyPatch(ctx(crashing), { set: { OPERATOR_SETTING: 'second-value' } }, 'done')
    ).rejects.toThrow(/stopped/);
    const staged = journal.steps.test?.stagedBundleId as string;
    expect((await store.head()).bundle.bundleId).toBe(rotated.bundle.bundleId);
    await applyPatch(ctx(store), { set: { OPERATOR_SETTING: 'second-value' } }, 'done');
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
    const base = await store.head();
    const next = await store.seal(base.secrets);
    await expect(store.write(next, base.basis)).rejects.toThrow(/edited after it was sealed/);
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
    await expect(store.write(next, base.basis)).rejects.toThrow(/a later seal than this box's/);
    expect(bundlesOn(stateA).map((b) => b.bundleId)).not.toContain(next.bundleId);
    // A seal that read the head before another one moved it does not overwrite it.
    writeFileSync(bucketHeadPath(), genuine);
    const stale = headHint(genuine);
    await store.write(next, base.basis);
    // A rotation whose secrets were read before that write (a deploy moved the head meanwhile)
    // is refused instead of undoing it.
    const derivedEarlier = await store.seal(base.secrets);
    await expect(store.write(derivedEarlier, base.basis)).rejects.toThrow(
      /the current sealed bundle changed while/
    );
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
    // An older genuine head put back (a replay) passes every check except the write number the
    // operator noted: --expected-head-write refuses it.
    const latest = readFileSync(headPath(stateA), 'utf8');
    const latestWrite = headHint(latest)?.seq ?? 0;
    writeFileSync(bucketHeadPath(), genuine);
    await expect(
      runRebuild({
        box: boxOf(envB),
        stateDir: stateB,
        bucket: bucket(boxOf(envB)),
        detect: async () => ({ platform: null, candidates: [] }),
        log: () => undefined,
        expectedHeadWrite: latestWrite,
      })
    ).rejects.toThrow(/older genuine head was put back/);
    // Control: the box's genuine head (after the rotation's write) rebuilds, with the check too.
    writeFileSync(bucketHeadPath(), latest);
    const rebuilt = await runRebuild({
      box: boxOf(envB),
      stateDir: stateB,
      bucket: bucket(boxOf(envB)),
      detect: async () => ({ platform: null, candidates: [] }),
      log: () => undefined,
      expectedHeadWrite: latestWrite,
    });
    expect(rebuilt.bundleIds[0]).toBe(next.bundleId);
  });
});

describe('a box from before the head', () => {
  it('deploys the newest bundle by date, as before, then records the head on both sides', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    const { withValue, unset } = await sealThenRollClockBack(stateA, envA);
    const unsetId = unset.bundleId;
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
    // A rebuild that stopped part way after copying an (older) head, resumed without one: the
    // stale local head is removed, so the next deploy picks what this rebuild restored.
    mkdirSync(join(stateB, 'key-agent'), { recursive: true });
    writeFileSync(join(stateB, 'key-agent/rebuild-pending'), 'x\n');
    writeFileSync(
      headPath(stateB),
      await sealHead(
        { seq: 1, bundleId: unsetId, installationId: withValue.installationId },
        providerOf(stateA, envA)
      )
    );
    expect((await rebuild(true)).bundleIds[0]).toBe(withValue.bundleId);
    expect(existsSync(headPath(stateB))).toBe(false);
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
    // The bucket is down while the attempt fails: the head cannot be put back, so the attempt's
    // bundle stays (the box's head still names it) instead of leaving a head naming nothing.
    const sealOnTop = async () => {
      const bundle = await sealSecrets({ SAM_INSTALLATION_ID: 'a'.repeat(32) }, provider, {
        installationId: 'a'.repeat(32),
      });
      await settings.bundles.write(bundle);
      const current = existsSync(headPath(stateA))
        ? headHint(readFileSync(headPath(stateA), 'utf8'))
        : null;
      await commitHead(settings.bundles, bundle, provider, current);
    };
    await sealOnTop(); // the box already had a head before this attempt
    let initHead = '';
    const unreachable = {
      ...deps,
      init: async () => {
        await sealOnTop();
        initHead = readFileSync(headPath(stateA), 'utf8');
      },
      preflight: async () => {
        vi.stubEnv('PATH', '/nonexistent'); // gcloud is gone: every bucket call fails
        throw new Error('the Worker would not get these secrets unchanged');
      },
    } as unknown as MigrateDeps;
    await expect(runMigration({ box, stateDir: stateA }, unreachable)).rejects.toThrow(/unchanged/);
    vi.stubEnv('PATH', env.PATH);
    const left = headHint(readFileSync(headPath(stateA), 'utf8'))?.bundleId;
    expect(readFileSync(headPath(stateA), 'utf8')).toBe(initHead);
    expect(bundlesOn(stateA).map((b) => b.bundleId)).toContain(left);
    // Another seal moved the head while the attempt was failing: cleanup leaves its head and
    // bundle alone instead of rolling them back.
    let other = '';
    const racing = {
      ...deps,
      init: sealOnTop,
      preflight: async () => {
        const mine = headHint(readFileSync(headPath(stateA), 'utf8'));
        const theirs = await sealSecrets({ SAM_INSTALLATION_ID: 'a'.repeat(32) }, provider, {
          installationId: 'a'.repeat(32),
        });
        await settings.bundles.write(theirs);
        await commitHead(settings.bundles, theirs, provider, mine);
        other = theirs.bundleId;
        throw new Error('the Worker would not get these secrets unchanged');
      },
    } as unknown as MigrateDeps;
    await expect(runMigration({ box, stateDir: stateA }, racing)).rejects.toThrow(/unchanged/);
    expect(headHint(readFileSync(headPath(stateA), 'utf8'))?.bundleId).toBe(other);
    expect(bundlesOn(stateA).map((b) => b.bundleId)).toContain(other);
  });
});

describe('the head bundle lost on the box but kept in the bucket', () => {
  it('reconcile restores it from the bucket instead of pruning it, and the deploy runs', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    const { unset } = await sealThenRollClockBack(stateA, envA);
    // The box lost the current bundle (disk damage, a mistaken rm); the bucket still has it.
    rmSync(join(bundleDir(stateA), `${unset.bundleId}.json`));
    const out = await deploy(envA, []);
    expect(out).toContain(`restored bundle ${unset.bundleId}, which the head names`);
    expect(bundlesOn(stateA).map((b) => b.bundleId)).toContain(unset.bundleId);
    expect(existsSync(join(gcsRoot, 'fleet/celld/sam-box/bundles', `${unset.bundleId}.json`))).toBe(
      true
    );
    expect(await namedBundle(envA)).toBe(unset.bundleId);
    // Neither holds it: the deploy stops and the bucket is left as it was.
    rmSync(join(bundleDir(stateA), `${unset.bundleId}.json`));
    rmSync(join(gcsRoot, 'fleet/celld/sam-box/bundles', `${unset.bundleId}.json`));
    const before = readdirSync(join(gcsRoot, 'fleet/celld/sam-box/bundles')).sort();
    const refused = await runDeploy(envA, ['--init', '--skip-vm-agent'], deployEnv(envA));
    expect(refused.status).not.toBe(0);
    expect(refused.out).toMatch(/which neither .* nor the fleet bucket holds/);
    expect(readdirSync(join(gcsRoot, 'fleet/celld/sam-box/bundles')).sort()).toEqual(before);
  });
});

describe('the head lock', () => {
  it('lets only one of two seals that read the same head make its bundle current', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    writeSecrets(stateA, []);
    await deploy(envA, ['--init']);
    vi.stubEnv('PATH', env.PATH);
    vi.stubEnv('FAKE_GCS_ROOT', gcsRoot);
    const store = openRotationStore(boxOf(envA), stateA);
    const current = await store.head();
    const previous = headHint(readFileSync(headPath(stateA), 'utf8'));
    const [a, b] = [await store.seal(current.secrets), await store.seal(current.secrets)];
    await store.settings.bundles.write(a);
    await store.settings.bundles.write(b);
    // Both read the head before either writes, unless the lock serializes them: each read waits
    // (bounded) until the other has read too.
    let reads = 0;
    const raced: BundleStore = {
      ...store.settings.bundles,
      async readHead() {
        const text = await store.settings.bundles.readHead();
        reads += 1;
        const deadline = Date.now() + 500;
        while (reads < 2 && Date.now() < deadline) await new Promise((r) => setTimeout(r, 10));
        return text;
      },
    };
    const results = await Promise.allSettled([
      commitHead(raced, a, store.provider, previous),
      commitHead(raced, b, store.provider, previous),
    ]);
    expect(results.filter((r) => r.status === 'fulfilled')).toHaveLength(1);
    const lost = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    expect(String(lost.reason)).toMatch(/the current sealed bundle changed while/);
    expect(existsSync(`${headPath(stateA)}.lock`)).toBe(false);
  });

  it('breaks a lock left by a process that died, and waits for a live one', async () => {
    const lock = join(dir, 'state/key-agent/head.json.lock');
    mkdirSync(dirname(lock), { recursive: true });
    // A pid that is not running (beyond the kernel's default pid range).
    writeFileSync(lock, '4194399\n');
    await expect(withLockFile(lock, async () => 'ran')).resolves.toBe('ran');
    expect(existsSync(lock)).toBe(false);
    // A lock left empty by a crash between create and write is broken once it is a few seconds old.
    writeFileSync(lock, '');
    const old = new Date(Date.now() - 60_000);
    utimesSync(lock, old, old);
    await expect(withLockFile(lock, async () => 'ran', 200)).resolves.toBe('ran');
    // Two waiters saw the same dead holder; the first broke it and took a new lock. The second
    // breaks only the file it judged stale (same inode), so the new owner's lock survives.
    writeFileSync(lock, '4194399\n');
    const staleIno = statSync(lock).ino;
    writeFileSync(`${lock}.new`, `${process.pid}\n`);
    renameSync(`${lock}.new`, lock); // a distinct inode: both files existed at once
    breakStaleLock(lock, staleIno);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.pid}\n`);
    // A child joined (appended a live pid to the same file) after a waiter judged it stale: the
    // breaker judges again and leaves it.
    writeFileSync(lock, '4194399\n');
    const joinedIno = statSync(lock).ino;
    writeFileSync(lock, `4194399\n${process.pid}\n`);
    expect(statSync(lock).ino).toBe(joinedIno);
    breakStaleLock(lock, joinedIno);
    expect(existsSync(lock)).toBe(true);
    // Control: the file judged stale is removed; a breaker already held leaves it to its holder.
    writeFileSync(lock, '4194399\n');
    writeFileSync(`${lock}.break`, '');
    breakStaleLock(lock, statSync(lock).ino);
    expect(existsSync(lock)).toBe(true);
    rmSync(`${lock}.break`);
    breakStaleLock(lock, statSync(lock).ino);
    expect(existsSync(lock)).toBe(false);
    expect(existsSync(`${lock}.break`)).toBe(false);
    // A lock whose owner died but which a still-running child joined is held, not broken.
    writeFileSync(lock, `4194399\n${process.pid}\n`);
    await expect(withLockFile(lock, async () => 'ran', 200)).rejects.toThrow(/held by process/);
    // Control: once every process in it is gone, it is broken.
    writeFileSync(lock, '4194399\n4194398\n');
    await expect(withLockFile(lock, async () => 'ran', 200)).resolves.toBe('ran');
    // Joining an ancestor's lock checks it is still that lock: a replaced lock is not joined, and
    // a missing one is never created.
    // A dead owner's lock is not joined (it is stale; the joiner takes the lock instead).
    writeFileSync(lock, '4194390\n');
    expect(joinLockFile(lock, '4194390')).toBe(false);
    // The failed join leaves the file as it was (no pid of ours to wait on), so the joiner
    // then takes the stale lock at once.
    expect(readFileSync(lock, 'utf8')).toBe('4194390\n');
    await expect(withLockFile(lock, async () => 'ran', 200)).resolves.toBe('ran');
    // A live owner's lock is joined.
    writeFileSync(lock, `${process.ppid}\n`);
    expect(joinLockFile(lock, String(process.ppid))).toBe(true);
    expect(readFileSync(lock, 'utf8')).toBe(`${process.ppid}\n${process.pid}\n`);
    writeFileSync(lock, '4194390\n');
    writeFileSync(`${lock}.new`, '4194391\n');
    renameSync(`${lock}.new`, lock);
    expect(joinLockFile(lock, '4194390')).toBe(false);
    // Even a replacement naming the same owner (a reused pid) is another file, not joined: the
    // check is on the file joined, not only its text. (Simulated by swapping the file mid-join.)
    const live = String(process.ppid);
    writeFileSync(lock, `${live}\n`);
    const swap = (): void => {
      writeFileSync(`${lock}.new`, `${live}\n`);
      renameSync(`${lock}.new`, lock);
    };
    expect(joinLockFile(lock, live, swap)).toBe(false);
    rmSync(lock);
    expect(joinLockFile(lock, '4194390')).toBe(false);
    expect(existsSync(lock)).toBe(false);
    // A live holder (this process) is waited for, then refused with the holder named.
    writeFileSync(lock, `${process.pid}\n`);
    await expect(withLockFile(lock, async () => 'ran', 200)).rejects.toThrow(
      new RegExp(`held by process ${process.pid}`)
    );
  });
});

describe('the sealing lock (one sealing operation per box)', () => {
  it('a deploy waits for another operation, and that operation’s own deploys re-enter it', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    writeSecrets(stateA, []);
    await deploy(envA, ['--init']);
    await withSealingLock(stateA, async () => {
      // A child deploy of the operation holding the lock (it inherits SAM_SELFHOST_SEALING_LOCK).
      const own = await runDeploy(envA, ['--init', '--skip-vm-agent'], deployEnv(envA));
      expect(own.status, own.out).toBe(0);
      // Any other deploy (no inherited holder) is refused, naming the holder, and touches nothing
      // before it waits: not even agent.env (a switch in progress may be rewriting it).
      const agentEnv = join(stateA, 'key-agent/agent.env');
      writeFileSync(agentEnv, 'SAM_KEY_PROVIDER=set-by-the-holder\n', { mode: 0o600 });
      const other = await runDeploy(envA, ['--init', '--skip-vm-agent'], {
        ...deployEnv(envA),
        [SEALING_LOCK_ENV]: '',
      });
      expect(other.status).not.toBe(0);
      expect(other.out).toMatch(new RegExp(`sealing\\.lock is held by process ${process.pid}`));
      expect(readFileSync(agentEnv, 'utf8')).toBe('SAM_KEY_PROVIDER=set-by-the-holder\n');
    });
    expect(existsSync(join(stateA, 'key-agent/sealing.lock'))).toBe(false);
    // Control: once released, a deploy runs.
    await deploy(envA, ['--init']);
  });
});

describe('a rotation resumed on a box without a head yet', () => {
  it('makes the staged bundle current when the date fallback still picks the one it replaced', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    writeSecrets(stateA, []);
    await deploy(envA, ['--init']);
    // An upgraded box that has not recorded its head yet.
    rmSync(headPath(stateA));
    rmSync(bucketHeadPath());
    vi.stubEnv('PATH', env.PATH);
    vi.stubEnv('FAKE_GCS_ROOT', gcsRoot);
    const store = openRotationStore(boxOf(envA), stateA);
    const over = await store.head();
    expect(over.basis).toBeNull();
    // The staged bundle, written before a stop, sealed while the clock was an hour behind.
    const staged = await sealSecrets(over.secrets, store.provider, {
      installationId: over.bundle.installationId,
      now: () => new Date(Date.parse(over.bundle.createdAt) - HOUR_MS),
    });
    await store.settings.bundles.write(staged);
    expect((await store.head()).bundle.bundleId).toBe(over.bundle.bundleId);
    await store.makeCurrent(staged.bundleId, over.bundle.bundleId);
    expect((await store.head()).bundle.bundleId).toBe(staged.bundleId);
    expect(headHint(readFileSync(headPath(stateA), 'utf8'))?.seq).toBe(1);
  });
});

describe('a rotation on a box without a head yet', () => {
  it('records the head naming the current bundle before staging the new one', async () => {
    const stateA = join(dir, 'box-a/.state');
    const envA = boxEnv(stateA);
    writeSecrets(stateA, []);
    await deploy(envA, ['--init']);
    rmSync(headPath(stateA));
    rmSync(bucketHeadPath());
    vi.stubEnv('PATH', env.PATH);
    vi.stubEnv('FAKE_GCS_ROOT', gcsRoot);
    const store = openRotationStore(boxOf(envA), stateA);
    const before = await store.head();
    const journal: Journal = {
      format: 'sam-key-rotation/1',
      id: 'r2',
      startedAt: new Date().toISOString(),
      backupDir: null,
      keys: ['test'],
      steps: { test: { name: 'test', phase: 'pending' } },
    };
    const ctx: StepContext = {
      journal,
      step: journal.steps.test as StepContext['step'],
      key: { name: 'test' } as StepContext['key'],
      // Stops after writing the staged bundle, before making it current.
      store: {
        ...store,
        write: async (bundle: SealedBundle) => {
          await store.settings.bundles.write(bundle);
          throw new Error('stopped');
        },
      },
      deps: { log: () => undefined } as unknown as RotateDeps,
      stateDir: stateA,
      save: () => undefined,
    };
    await expect(applyPatch(ctx, { set: { OPERATOR_SETTING: 'x-value' } }, 'done')).rejects.toThrow(
      /stopped/
    );
    // The head names the bundle the rotation started from, so the newer-dated staged bundle is
    // not what the next deploy or the resume picks.
    expect(headHint(readFileSync(headPath(stateA), 'utf8'))?.bundleId).toBe(before.bundle.bundleId);
    expect((await store.head()).bundle.bundleId).toBe(before.bundle.bundleId);
  });
});
