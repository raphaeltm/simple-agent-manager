/**
 * The automatic key-provider choice on each platform, through the real `deploy.ts --init` entry
 * point: fake instance metadata services (platform-probe.ts) and fake key services
 * (key-provider-fakes.ts) answer the child process the way Google Cloud, Azure and AWS document.
 *
 * For every platform: a working key is selected; no key configured, a key the VM may not use, and
 * slow or absent metadata all fall back to the file key with the reason in one line; the choice
 * is recorded and no key material is printed.
 */
import { mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { FAKE_AWS_REGION, type FakeAws, startFakeAws } from './aws-kms-fake.js';
import { CLOSED_HOST, runDeploy, writeBox } from './deploy-harness.js';
import { installKeyName } from './key-platforms.js';
import { type FakeKeyService, startFakeKeyServices } from './key-provider-fakes.js';

const PROJECT = 'sam-fake-project';
const KEY_NAME = installKeyName('sam.example.com');
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

  it('key exists but this VM may not use it: falls back to the file key (denied)', async () => {
    fake = await startFakeKeyServices({ gcpProject: PROJECT, existingKeys: [GCP_KEY] });
    fake.setDenied(true);
    const envFile = writeBox(dir, [
      ...elsewhere('gce'),
      `SAM_GCE_METADATA_HOST=${fake.host}`,
      `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
    ]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toMatch(/key provider: file \(on Google Cloud .* is not usable \(denied:/);
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

  it('key exists but the role may not use it: file key (denied)', async () => {
    const init = await awsInit([`alias/${KEY_NAME}`], true);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain('(denied: aws-kms');
    expect(bundleProviders()).toEqual(['file']);
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

  it('on Azure with no vault configured: file key, and the line names the missing setting', async () => {
    fake = await startFakeKeyServices();
    const envFile = writeBox(dir, [...elsewhere('azure'), `SAM_AZURE_IMDS_HOST=${fake.host}`]);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain(
      'key provider: file (on Azure (westeurope), but SAM_AZURE_KEY_VAULT_URL is not set'
    );
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
