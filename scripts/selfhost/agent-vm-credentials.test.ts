/**
 * Agent VMs never receive the fleet bucket credential or any key-service credential (multi-box
 * plan, idea 01M7V5DMWTXWDMCWA5T4YC9HC5). A node gets only what the API Worker gives it: the
 * cloud-init the Worker renders and the callbacks it answers, all from the Worker's own env. So
 * the property is: neither the Worker's deployed vars nor the sealed secrets the key agent hands
 * it at runtime hold one of those credentials. Run through the real `pnpm selfhost:deploy` entry
 * on a sealed box that has all of them (the bucket key in .env, provider settings, a credential
 * file, the file key). celld's own process env (where the bucket key lives) is not the Worker's:
 * live/metadata-proxy.live.test.ts proves a native env canary is absent from Worker code.
 */
import { mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openBundle, parseBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import { createFileProvider } from '../../deploy/selfhost/key-agent/provider-file.ts';
import { CHILD_TEST_TIMEOUT_MS, noStackDocker, runDeploy, writeBox } from './deploy-harness.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

const BUCKET_KEY_ID = 'fleet-key-id-for-agent-vm-test';
const BUCKET_SECRET = 'fleet-bucket-secret-0123456789abcdef';
const TRANSIT_SECRET_ID = 'approle-secret-id-0123456789abcdef';
const KMS_SETTINGS = [
  'SAM_GCP_KMS_KEY=projects/p/locations/global/keyRings/sam-selfhost/cryptoKeys/sam-decoy',
  'SAM_AWS_KMS_KEY_ID=alias/sam-decoy-agent-vm',
  'SAM_TRANSIT_ROLE_ID=transit-role-decoy-0123',
  'SAM_TRANSIT_ADDR=https://vault.decoy.example:8200',
];

let dir: string;
let state: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-agent-vm-creds-'));
  state = join(dir, '.state');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('agent VMs never receive bucket or key-service credentials', () => {
  it('the sealed Worker holds none, neither in its deployed vars nor in its runtime secrets', async () => {
    const envFile = writeBox(dir, [
      'SAM_KEY_PROVIDER=file',
      `AWS_ACCESS_KEY_ID=${BUCKET_KEY_ID}`,
      `AWS_SECRET_ACCESS_KEY=${BUCKET_SECRET}`,
      ...KMS_SETTINGS,
    ]);
    mkdirSync(join(state, 'key-agent', 'credentials'), { recursive: true, mode: 0o700 });
    writeFileSync(join(state, 'key-agent', 'credentials', 'transit-secret-id'), TRANSIT_SECRET_ID, {
      mode: 0o600,
    });
    const env = noStackDocker(dir);
    const init = await runDeploy(envFile, ['--init'], env);
    expect(init.status, init.out).toBe(0);
    const kek = readFileSync(join(state, 'key-agent', 'kek'), 'utf8').trim();

    const dry = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent'], env);
    expect(dry.status, dry.out).toBe(0);
    const config = JSON.parse(dry.out.slice(dry.out.indexOf('{\n'))) as {
      vars: Record<string, string>;
    };
    const [name] = readdirSync(join(state, 'key-agent', 'bundles'));
    const bundle = parseBundle(
      readFileSync(join(state, 'key-agent', 'bundles', name ?? ''), 'utf8')
    );
    const runtime = await openBundle(
      bundle,
      createFileProvider({ SAM_KEY_FILE: join(state, 'key-agent', 'kek') })
    );

    // Liveness: this is a sealed Worker, and its secrets are there.
    expect(config.vars.SAM_KEY_AGENT_ADDRESS).toBe('127.0.0.1:7190');
    expect(runtime.ENCRYPTION_KEY).toBeTruthy();
    // Control: the box itself does hold the key-service settings (the agent's env), so the
    // absence below is not the settings never existing.
    const agentEnv = readFileSync(join(state, 'key-agent', 'agent.env'), 'utf8');
    expect(agentEnv).toContain('SAM_GCP_KMS_KEY=');
    expect(agentEnv).toContain('SAM_TRANSIT_SECRET_ID_FILE=/etc/sam/key-agent/credentials/');

    const workerSees = `${JSON.stringify(config.vars)}\n${JSON.stringify(runtime)}`;
    const credentials = {
      BUCKET_KEY_ID,
      BUCKET_SECRET,
      TRANSIT_SECRET_ID,
      kek,
      ...Object.fromEntries(KMS_SETTINGS.map((line) => line.split('=') as [string, string])),
    };
    for (const [label, value] of Object.entries(credentials)) {
      expect(workerSees.includes(value), label).toBe(false);
    }
    const names = [...Object.keys(config.vars), ...Object.keys(runtime)];
    expect(
      names.filter((n) =>
        /^(AWS_ACCESS_KEY_ID|AWS_SECRET_ACCESS_KEY|SAM_KEY_FILE|SAM_TRANSIT_|SAM_GCP_KMS|SAM_AWS_KMS|SAM_AZURE_|SAM_KEY_PROVIDER)/.test(
          n
        )
      )
    ).toEqual([]);
  });
});
