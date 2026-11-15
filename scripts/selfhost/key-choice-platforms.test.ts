/**
 * The automatic key-provider choice on each platform, through the real `deploy.ts --init` entry
 * point: fake instance metadata services (platform-probe.ts) and fake key services
 * (key-provider-fakes.ts) answer the child process the way Google Cloud, Azure and AWS document.
 *
 * For every platform: a working key is selected; no key set up (the key service says it does not
 * exist) and slow or absent metadata fall back to the file key with the reason in one line; a key
 * that is configured in .env, or exists but cannot be used (denied, no enabled version), stops
 * `--init` instead (sealingFloorRefusal in key-choice.ts). The choice is recorded and no key
 * material is printed.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { FAKE_AWS_REGION, type FakeAws, startFakeAws } from './aws-kms-fake.js';
import {
  CHILD_TEST_TIMEOUT_MS,
  CLOSED_HOST,
  runDeploy,
  runTsx,
  writeBox,
} from './deploy-harness.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });
import { installKeyName } from './key-platforms.js';
import { type FakeKeyService, startFakeKeyServices } from './key-provider-fakes.js';

const PROJECT = 'sam-fake-project';
const KEY_NAME = installKeyName('sam.example.com');
const SECRETS = join(import.meta.dirname, 'secrets.ts');
const GCP_KEY = `projects/${PROJECT}/locations/global/keyRings/sam-selfhost/cryptoKeys/${KEY_NAME}`;

let dir: string;
let fake: FakeKeyService | undefined;
let aws: FakeAws | undefined;
const extras: Server[] = [];

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-keyplat-'));
});
afterEach(async () => {
  await fake?.close();
  fake = undefined;
  await aws?.close();
  aws = undefined;
  for (const server of extras.splice(0)) server.close();
  rmSync(dir, { recursive: true, force: true });
});

/** A fake /sys/class/dmi/id naming the platform (or none), as the cloud's firmware does. */
function dmi(platform: 'gcp' | 'aws' | 'azure' | 'none'): string {
  const path = join(dir, `dmi-${platform}`);
  mkdirSync(path, { recursive: true });
  const files: Record<string, string> =
    platform === 'gcp'
      ? { sys_vendor: 'Google', product_name: 'Google Compute Engine' }
      : platform === 'aws'
        ? { sys_vendor: 'Amazon EC2', product_name: 'm6i.large' }
        : platform === 'azure'
          ? {
              sys_vendor: 'Microsoft Corporation',
              chassis_asset_tag: '7783-7084-3265-9085-8269-3286-77',
            }
          : { sys_vendor: 'Hetzner', product_name: 'vServer' };
  for (const [name, value] of Object.entries(files)) writeFileSync(join(path, name), `${value}\n`);
  return `SAM_DMI_DIR=${path}`;
}

function choice(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(dir, '.state/key-agent/choice.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

function bundleProviders(): string[] {
  const bundles = join(dir, '.state/key-agent/bundles');
  return readdirSync(bundles).map(
    (name) =>
      (JSON.parse(readFileSync(join(bundles, name), 'utf8')) as { provider: string }).provider
  );
}

/** A refused automatic choice records nothing and seals nothing. */
function expectNothingSealed(): void {
  expect(existsSync(join(dir, '.state/key-agent/choice.json'))).toBe(false);
  const bundles = join(dir, '.state/key-agent/bundles');
  expect(existsSync(bundles) ? readdirSync(bundles) : []).toEqual([]);
}

/** A metadata host that accepts the connection and never answers. */
async function silentHost(): Promise<string> {
  const server = createServer(() => undefined);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  extras.push(server);
  return `127.0.0.1:${(server.address() as AddressInfo).port}`;
}

const elsewhere = (except: 'gce' | 'aws' | 'azure') =>
  [
    except === 'gce' ? null : `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
    except === 'aws' ? null : `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
    except === 'azure' ? null : `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
  ].filter((line): line is string => line !== null);

async function gcpInit(existingKeys?: string[], extra: string[] = []) {
  fake = await startFakeKeyServices({ gcpProject: PROJECT, existingKeys });
  const envFile = writeBox(dir, [
    ...elsewhere('gce'),
    `SAM_GCE_METADATA_HOST=${fake.host}`,
    `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
    dmi('gcp'),
    ...extra,
  ]);
  return await runDeploy(envFile, ['--init']);
}

describe('Google Cloud', () => {
  it('selects the bootstrap-created Cloud KMS key once it round-trips, through the VM identity', async () => {
    const init = await gcpInit([GCP_KEY]);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain(
      `key provider: gcp-kms (Google Cloud (project ${PROJECT}): Cloud KMS key ${GCP_KEY} passed`
    );
    expect(choice()).toMatchObject({
      provider: 'gcp-kms',
      settings: { SAM_GCP_KMS_KEY: GCP_KEY },
      source: 'auto',
    });
    expect(bundleProviders()).toEqual(['gcp-kms']);
    expect(readFileSync(join(dir, '.state/key-agent/agent.env'), 'utf8')).toContain(
      `SAM_GCP_KMS_KEY=${GCP_KEY}`
    );
    // No key file: the VM identity is the credential.
    expect(readdirSync(join(dir, '.state/key-agent'))).not.toContain('kek');
    expect(init.out).not.toContain(fake?.token ?? 'unset');
  });

  it('uses a key configured in .env over the conventional name', async () => {
    const own = `projects/${PROJECT}/locations/europe-west1/keyRings/mine/cryptoKeys/box`;
    const init = await gcpInit([own], [`SAM_GCP_KMS_KEY=${own}`]);
    expect(init.status, init.out).toBe(0);
    expect(choice()).toMatchObject({ provider: 'gcp-kms', settings: { SAM_GCP_KMS_KEY: own } });
  });

  it('on Google Cloud with no key set up: falls back to the file key and says why', async () => {
    const init = await gcpInit([]);
    expect(init.status, init.out).toBe(0);
    const line = init.out.split('\n').find((l) => l.includes('key provider:')) ?? '';
    expect(line).toContain('key provider: file (on Google Cloud (project sam-fake-project), but');
    expect(line).toContain(`Cloud KMS key ${GCP_KEY} is not usable (config:`);
    expect(choice()).toMatchObject({ provider: 'file', source: 'auto' });
    expect(bundleProviders()).toEqual(['file']);
  });

  it('key exists but this VM may not use it: stops --init instead of choosing the file key (denied)', async () => {
    fake = await startFakeKeyServices({ gcpProject: PROJECT, existingKeys: [GCP_KEY] });
    fake.setDenied(true);
    const envFile = writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${fake.host}`,
      `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
      dmi('gcp'),
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status).not.toBe(0);
    expect(init.out).toContain(`Cloud KMS key ${GCP_KEY} is not usable (denied:`);
    expect(init.out).toContain('SAM_KEY_PROVIDER=file');
    expectNothingSealed();
  });

  // Box round R14: on a new box whose bootstrap stopped at a destroyed key, the box account has
  // no grant, so Cloud KMS answers 403 instead of FAILED_PRECONDITION. The refusal must name the
  // dead-key cause too, and print the same --new-key-version command.
  it('denied: names a destroyed key as a likely cause and prints the --new-key-version command', async () => {
    fake = await startFakeKeyServices({ gcpProject: PROJECT, existingKeys: [GCP_KEY] });
    fake.setDenied(true);
    const envFile = writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${fake.host}`,
      `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
      dmi('gcp'),
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status).not.toBe(0);
    expect(init.out).toContain('refusing to seal this box');
    expect(init.out).toContain('denied (403)');
    expect(init.out).toContain('destroyed or scheduled for destruction');
    expect(init.out).toContain(
      `\`pnpm selfhost:gcp-bootstrap -- --project ${PROJECT} --api-url ` +
        'https://api.sam.example.com --kms-only --box-instance <box VM> --box-zone <zone> ' +
        '--new-key-version`'
    );
    expect(init.out).toContain('--restore-key-version');
    // Still no fallback: nothing on disk.
    expect(init.out).not.toContain('key provider: file');
    expectNothingSealed();
  });

  it('denied on a key named in .env: the command names that key, ring and location', async () => {
    const own = `projects/${PROJECT}/locations/europe-west1/keyRings/mine/cryptoKeys/box`;
    fake = await startFakeKeyServices({ gcpProject: PROJECT, existingKeys: [own] });
    fake.setDenied(true);
    const envFile = writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${fake.host}`,
      `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
      dmi('gcp'),
      `SAM_GCP_KMS_KEY=${own}`,
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status).not.toBe(0);
    expect(init.out).toContain('SAM_GCP_KMS_KEY is set in .env');
    expect(init.out).toContain(
      '--kms-only --kms-location europe-west1 --key-ring mine --key box --box-instance <box VM>'
    );
    expect(init.out).toContain('--new-key-version');
    expectNothingSealed();
  });
});

/**
 * Box round R13: `teardown --destroy-key` leaves the key's name with its only version
 * DESTROY_SCHEDULED; the rebuilt box's `--init` used to record the file key without a word.
 */
describe('Google Cloud key with no enabled primary version (box round R13)', () => {
  async function r13Init(extra: string[] = []) {
    fake = await startFakeKeyServices({ gcpProject: PROJECT, existingKeys: [GCP_KEY] });
    fake.setGcpPrimaryState(GCP_KEY, 'DESTROY_SCHEDULED');
    const envFile = writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${fake.host}`,
      `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
      dmi('gcp'),
      ...extra,
    ]);
    return { envFile, init: await runDeploy(envFile, ['--init']) };
  }

  it('the default name: --init stops, names the key, the cause and the fix; nothing is recorded or sealed', async () => {
    const { init } = await r13Init();
    expect(init.status).not.toBe(0);
    expect(init.out).not.toContain('key provider: file');
    expect(init.out).toContain(`Cloud KMS key ${GCP_KEY} is not usable (invalid:`);
    expect(init.out).toContain('FAILED_PRECONDITION');
    expect(init.out).toContain('no enabled primary version');
    expect(init.out).toContain('--new-key-version');
    expect(init.out).toContain('SAM_KEY_PROVIDER=file');
    expectNothingSealed();
  });

  it('the key named in .env: same refusal', async () => {
    const { init } = await r13Init([`SAM_GCP_KMS_KEY=${GCP_KEY}`]);
    expect(init.status).not.toBe(0);
    expect(init.out).toContain('SAM_GCP_KMS_KEY is set in .env');
    expectNothingSealed();
  });

  it('once the key has an enabled version again, --init selects it', async () => {
    const { envFile, init } = await r13Init();
    expect(init.status).not.toBe(0);
    fake?.setGcpPrimaryState(GCP_KEY, 'ENABLED');
    const again = await runDeploy(envFile, ['--init']);
    expect(again.status, again.out).toBe(0);
    expect(choice()).toMatchObject({ provider: 'gcp-kms', settings: { SAM_GCP_KMS_KEY: GCP_KEY } });
    expect(bundleProviders()).toEqual(['gcp-kms']);
  });

  it('SAM_KEY_PROVIDER=file is the operator choosing the key file on purpose: it works', async () => {
    const { init } = await r13Init(['SAM_KEY_PROVIDER=file']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain('key provider: file (SAM_KEY_PROVIDER=file in .env)');
    expect(bundleProviders()).toEqual(['file']);
  });

  it('secrets status on a box that seals with the file key warns that a cloud key exists', async () => {
    // A box that recorded the file key before this fix (R13's box), on Google Cloud.
    const { envFile } = await r13Init(['SAM_KEY_PROVIDER=file']);
    writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${fake?.host}`,
      `SAM_GCP_KMS_ENDPOINT=http://${fake?.host}`,
      dmi('gcp'),
    ]);
    writeFileSync(
      join(dir, '.state/key-agent/choice.json'),
      JSON.stringify({
        format: 'sam-key-choice/1',
        provider: 'file',
        settings: {},
        reason: 'on Google Cloud, but ... is not usable; using a key file on this box',
        source: 'auto',
        chosenAt: '2026-11-14T21:15:07.000Z',
      })
    );
    const broken = await runTsx(SECRETS, ['status', '--box-env', envFile]);
    expect(broken.status, broken.out).toBe(0);
    expect(broken.out).toContain('sealed by:  a key file on this box');
    expect(broken.out).toContain(`WARNING: Cloud KMS key ${GCP_KEY} exists but is not usable`);
    expect(broken.out).toContain('--new-key-version');

    fake?.setGcpPrimaryState(GCP_KEY, 'ENABLED');
    const usable = await runTsx(SECRETS, ['status', '--box-env', envFile]);
    expect(usable.out).toContain(`WARNING: Cloud KMS key ${GCP_KEY} works on this machine`);
    expect(usable.out).toContain('pnpm selfhost:secrets switch --to auto');
    // A later deploy keeps the recorded choice: a box sealed with the file key stays on it.
    const deploy = await runDeploy(envFile, ['--init']);
    expect(deploy.status, deploy.out).toBe(0);
    expect(deploy.out).toContain('key provider: file (on Google Cloud, but');
    expect(bundleProviders()).toEqual(['file']);
  });
});

describe('AWS', () => {
  async function awsInit(existingKeys?: string[], denied = false) {
    aws = await startFakeAws({ existingKeys });
    aws.setDenied(denied);
    const envFile = writeBox(dir, [
      ...elsewhere('aws'),
      `SAM_AWS_IMDS_HOST=${aws.host}`,
      `SAM_AWS_KMS_ENDPOINT=http://${aws.host}/`,
      dmi('aws'),
    ]);
    return await runDeploy(envFile, ['--init']);
  }

  it('selects the setup-created KMS alias in the instance region, signed with the instance role', async () => {
    const init = await awsInit([`alias/${KEY_NAME}`]);
    expect(init.status, init.out).toBe(0);
    expect(choice()).toMatchObject({
      provider: 'aws-kms',
      settings: { SAM_AWS_KMS_KEY_ID: `alias/${KEY_NAME}`, SAM_AWS_KMS_REGION: FAKE_AWS_REGION },
    });
    expect(bundleProviders()).toEqual(['aws-kms']);
    expect(aws?.calls).toEqual(
      expect.arrayContaining(['TrentService.Encrypt', 'TrentService.Decrypt'])
    );
    for (const secret of aws?.secrets() ?? []) expect(init.out).not.toContain(secret);
  });

  it('on AWS with no key set up: file key, NotFoundException named in the reason', async () => {
    const init = await awsInit([]);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain(
      `key provider: file (on AWS (${FAKE_AWS_REGION}), but AWS KMS key alias/${KEY_NAME}`
    );
    expect(init.out).toContain('(config: aws-kms');
    expect(bundleProviders()).toEqual(['file']);
  });

  it('key exists but the role may not use it (or it is disabled or pending deletion): stops --init', async () => {
    const init = await awsInit([`alias/${KEY_NAME}`], true);
    expect(init.status).not.toBe(0);
    expect(init.out).toContain('(denied: aws-kms');
    expect(init.out).toContain('SAM_KEY_PROVIDER=file');
    // The generic denied advice; the Google Cloud bootstrap command is not offered on AWS.
    expect(init.out).toContain('denied means no key by that name was set up for this install');
    expect(init.out).not.toContain('selfhost:gcp-bootstrap');
    expectNothingSealed();
  });
});

/** Security review of F3: other ways the automatic choice could still go down silently. */
describe('no silent fallback through a missing identity or a missed probe', () => {
  it('a VM with no service account (token endpoint 404) stops --init: config is not "no key" (M2)', async () => {
    fake = await startFakeKeyServices({ gcpProject: PROJECT, existingKeys: [GCP_KEY] });
    fake.setNoGcpIdentity(true);
    const envFile = writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${fake.host}`,
      `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
      dmi('gcp'),
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status).not.toBe(0);
    expect(init.out).toContain('(config: gce metadata server: HTTP 404)');
    expect(init.out).toContain('no service account or instance role attached');
    expectNothingSealed();
  });

  it('a key configured in .env with no cloud detected (probe missed) stops --init (M1)', async () => {
    const init = await runDeploy(
      writeBox(dir, [
        ...elsewhere('gce'),
        `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
        `SAM_GCP_KMS_KEY=${GCP_KEY}`,
      ]),
      ['--init']
    );
    expect(init.status).not.toBe(0);
    expect(init.out).toContain(
      'SAM_GCP_KMS_KEY is set in .env, but no cloud instance identity was detected'
    );
    expect(init.out).toContain('SAM_KEY_PROVIDER=gcp-kms');
    expectNothingSealed();
    // Sealed with the key file on purpose, status still says the configured key was not used.
    const envFile = writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
      `SAM_GCP_KMS_KEY=${GCP_KEY}`,
      'SAM_KEY_PROVIDER=file',
    ]);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    const status = await runTsx(SECRETS, ['status', '--box-env', envFile]);
    expect(status.out).toContain(
      'WARNING: SAM_GCP_KMS_KEY is set in .env, but no cloud instance identity was detected'
    );
  });

  it('control: off a cloud with no cloud key configured, the key file as before', async () => {
    const init = await runDeploy(
      writeBox(dir, [...elsewhere('gce'), `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`]),
      ['--init']
    );
    expect(init.status, init.out).toBe(0);
    expect(choice()).toMatchObject({ provider: 'file', source: 'auto' });
  });
});

describe('a cloud key service that does not answer', () => {
  it('stops --init instead of recording the file key for good', async () => {
    const init = await gcpInit([GCP_KEY], [`SAM_GCP_KMS_ENDPOINT=http://${CLOSED_HOST}`]);
    expect(init.status).not.toBe(0);
    expect(init.out).toContain('could not be reached (unavailable:');
    expect(init.out).toContain('SAM_KEY_PROVIDER=file');
    expect(() => choice()).toThrow();
  });
});

describe('Azure', () => {
  it('selects the configured Key Vault key after a round trip with the managed identity', async () => {
    fake = await startFakeKeyServices({ existingKeys: [KEY_NAME] });
    const envFile = writeBox(dir, [
      ...elsewhere('azure'),
      `SAM_AZURE_IMDS_HOST=${fake.host}`,
      `SAM_AZURE_KEY_VAULT_URL=http://${fake.host}`,
      'SAM_AZURE_ALLOW_HTTP_FOR_TESTS=1',
      dmi('azure'),
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(choice()).toMatchObject({
      provider: 'azure-kv',
      settings: { SAM_AZURE_KEY_VAULT_URL: `http://${fake.host}`, SAM_AZURE_KEY_NAME: KEY_NAME },
    });
    expect(bundleProviders()).toEqual(['azure-kv']);
    // The test-only HTTP switch never reaches the agent.
    expect(readFileSync(join(dir, '.state/key-agent/agent.env'), 'utf8')).not.toContain(
      'ALLOW_HTTP'
    );
  });

  it('vault configured but the managed identity is refused: stops --init (denied)', async () => {
    fake = await startFakeKeyServices({ existingKeys: [KEY_NAME] });
    fake.setDenied(true);
    const envFile = writeBox(dir, [
      ...elsewhere('azure'),
      `SAM_AZURE_IMDS_HOST=${fake.host}`,
      `SAM_AZURE_KEY_VAULT_URL=http://${fake.host}`,
      'SAM_AZURE_ALLOW_HTTP_FOR_TESTS=1',
      dmi('azure'),
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status).not.toBe(0);
    expect(init.out).toMatch(/Key Vault key .* is not usable \(denied:/);
    expect(init.out).toContain('SAM_AZURE_KEY_VAULT_URL is set in .env');
    expectNothingSealed();
  });

  it('on Azure with no vault configured: file key, and the line names the missing setting', async () => {
    fake = await startFakeKeyServices();
    const envFile = writeBox(dir, [
      ...elsewhere('azure'),
      `SAM_AZURE_IMDS_HOST=${fake.host}`,
      dmi('azure'),
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain(
      'key provider: file (on Azure (westeurope), but SAM_AZURE_KEY_VAULT_URL is not set'
    );
  });
});

describe('a metadata answer the machine does not back', () => {
  it('a Google-looking answer on a non-Google machine is ignored, even with a working key', async () => {
    // Someone on a VPS's local network answers 169.254.169.254 as Google with their own project
    // and a key that works: without the DMI check the box would seal to the attacker's key.
    const init = await gcpInit([GCP_KEY], [dmi('none')]);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain(
      "Google Cloud: a metadata answer this machine's firmware (DMI) does not back; ignored"
    );
    expect(choice()).toMatchObject({ provider: 'file' });
    expect(bundleProviders()).toEqual(['file']);
  });
});

describe('no usable metadata', () => {
  it('slow metadata services: gives up after the probe timeout, file key', async () => {
    const slow = await silentHost();
    const envFile = writeBox(dir, [
      `SAM_GCE_METADATA_HOST=${slow}`,
      `SAM_AWS_IMDS_HOST=${slow}`,
      `SAM_AZURE_IMDS_HOST=${slow}`,
      'SAM_METADATA_PROBE_TIMEOUT_MS=400',
    ]);
    const started = Date.now();
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain(
      'key provider: file (no cloud instance identity was detected (Google Cloud: no answer in time; AWS: no answer in time; Azure: no answer in time)'
    );
    // Bounded: the probes run in parallel, so a slow service costs one timeout, not three.
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('absent metadata services: file key at once', async () => {
    const init = await runDeploy(
      writeBox(dir, elsewhere('gce').concat(`SAM_GCE_METADATA_HOST=${CLOSED_HOST}`)),
      ['--init']
    );
    expect(init.status, init.out).toBe(0);
    expect(choice()).toMatchObject({ provider: 'file' });
  });

  it('a metadata server that is not Google (no Metadata-Flavor answer header) is not Google', async () => {
    const impostor = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'text/plain' });
      res.end('sam-fake-project');
    });
    await new Promise<void>((done) => impostor.listen(0, '127.0.0.1', done));
    extras.push(impostor);
    const host = `127.0.0.1:${(impostor.address() as AddressInfo).port}`;
    const init = await runDeploy(
      writeBox(dir, [...elsewhere('gce'), `SAM_GCE_METADATA_HOST=${host}`]),
      ['--init']
    );
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain('Google Cloud: HTTP 200 without the Google metadata marker');
    expect(choice()).toMatchObject({ provider: 'file' });
  });
});
