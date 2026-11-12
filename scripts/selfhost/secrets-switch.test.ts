/**
 * `pnpm selfhost:secrets switch` / `reseal` (secrets-switch.ts) on a box set up by the real
 * `deploy.ts --init`, moving from the file key to Cloud KMS served by the fake (key-provider-fakes):
 * the agent's files during and after the switch, the rollback, a reseal, and a real
 * `deploy --dry-run` afterwards that runs on the new bundle.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, CLOSED_HOST, runDeploy, writeBox } from './deploy-harness.js';
import type { PlatformCandidates } from './key-choice.js';
import { type FakeKeyService, startFakeKeyServices } from './key-provider-fakes.js';
import { parseDotenv } from './secret-files.js';
import { runSwitch, type SwitchDeps } from './secrets-switch.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

const GCP_KEY = 'projects/sam-fake-project/locations/global/keyRings/sam-selfhost/cryptoKeys/box';
let dir: string;
let state: string;
let envFile: string;
let fake: FakeKeyService;
let steps: string[];
let logs: string[];
let duringDeploy: { previous: boolean; agentEnv: string; choice: string } | null;

function box(): Record<string, string> {
  return parseDotenv(readFileSync(envFile, 'utf8'), envFile);
}
const read = (path: string) => readFileSync(join(state, 'key-agent', path), 'utf8');
const bundleProviders = () =>
  readdirSync(join(state, 'key-agent/bundles'))
    .map((name) => (JSON.parse(read(`bundles/${name}`)) as { provider: string }).provider)
    .sort();

function deps(healthy: boolean[] = [true]): SwitchDeps {
  let check = 0;
  return {
    log: (message) => logs.push(message),
    detect: async (): Promise<PlatformCandidates> => ({
      platform: 'Google Cloud (project sam-fake-project)',
      candidates: [
        {
          provider: 'gcp-kms',
          settings: { SAM_GCP_KMS_KEY: GCP_KEY },
          label: `Cloud KMS key ${GCP_KEY}`,
        },
      ],
    }),
    restartAgent: async () => {
      steps.push('restart agent');
    },
    deploy: async () => {
      steps.push('deploy');
      duringDeploy ??= {
        previous: existsSync(join(state, 'key-agent/previous.env')),
        agentEnv: read('agent.env'),
        choice: read('choice.json'),
      };
    },
    adoptAndCheck: async () => {
      steps.push('reload+health');
      const ok = healthy[Math.min(check, healthy.length - 1)] ?? true;
      check += 1;
      return { healthy: ok, detail: ok ? 'HTTP 200' : 'HTTP 503 SECRETS_UNAVAILABLE' };
    },
  };
}

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'sam-switch-'));
  state = join(dir, '.state');
  fake = await startFakeKeyServices({ gcpProject: 'sam-fake-project' });
  // The box first sealed with the file key (no cloud key yet), as on the test box.
  envFile = writeBox(dir, [
    `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
    `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
    `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
  ]);
  const init = await runDeploy(envFile, ['--init']);
  expect(init.status, init.out).toBe(0);
  // Now the metadata server and Cloud KMS answer (the operator set the key up afterwards).
  envFile = writeBox(dir, [
    `SAM_GCE_METADATA_HOST=${fake.host}`,
    `SAM_GCP_KMS_ENDPOINT=http://${fake.host}`,
    `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
    `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
  ]);
  steps = [];
  logs = [];
  duringDeploy = null;
});
afterEach(async () => {
  await fake.close();
  rmSync(dir, { recursive: true, force: true });
});

describe('secrets switch', () => {
  it('moves the file-key box to Cloud KMS: old provider kept for the running version, then dropped', async () => {
    const choice = await runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, deps());
    expect(choice).toMatchObject({
      provider: 'gcp-kms',
      settings: { SAM_GCP_KMS_KEY: GCP_KEY },
      source: 'switch',
    });
    expect(steps).toEqual(['restart agent', 'deploy', 'reload+health', 'restart agent']);
    // While the new Worker version deploys, the agent has both: the new provider, and the old
    // one for the bundle the running version still names.
    expect(duringDeploy?.previous).toBe(true);
    expect(duringDeploy?.agentEnv).toContain(`SAM_GCP_KMS_KEY=${GCP_KEY}`);
    expect(JSON.parse(duringDeploy?.choice ?? '{}')).toMatchObject({ provider: 'gcp-kms' });
    // Afterwards only the new one.
    expect(existsSync(join(state, 'key-agent/previous.env'))).toBe(false);
    expect(bundleProviders()).toEqual(['file', 'gcp-kms']);
    expect(logs.join('\n')).toContain('still opens older bundles and every backup sealed');

    // The real deploy now runs on the Cloud KMS bundle.
    const dry = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain('key provider: gcp-kms (switched from file');
    const gcpBundle = readdirSync(join(state, 'key-agent/bundles')).find((n) =>
      read(`bundles/${n}`).includes('"gcp-kms"')
    );
    expect(dry.out).toContain(`"SAM_SECRET_BUNDLE_ID": "${gcpBundle?.replace('.json', '')}"`);
  });

  it('rolls back to the old provider when the first request after the switch fails', async () => {
    const before = { choice: read('choice.json'), agentEnv: read('agent.env') };
    await expect(
      runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, deps([false, true]))
    ).rejects.toThrow(/switch rolled back: the new version is not healthy: HTTP 503/);
    expect(read('choice.json')).toBe(before.choice);
    expect(read('agent.env')).toBe(before.agentEnv);
    expect(existsSync(join(state, 'key-agent/previous.env'))).toBe(false);
    expect(bundleProviders()).toEqual(['file']);
    expect(steps).toEqual([
      'restart agent',
      'deploy',
      'reload+health',
      'restart agent',
      'deploy',
      'reload+health',
    ]);
  });

  it('refuses a target that cannot unwrap, and changes nothing', async () => {
    fake.setDenied(true);
    await expect(runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, deps())).rejects.toThrow(
      /gcp-kms .* is not usable: denied/
    );
    expect(bundleProviders()).toEqual(['file']);
    expect(steps).toEqual([]);
  });

  it('reseal: same provider, a new bundle and data key, no previous provider', async () => {
    const before = readdirSync(join(state, 'key-agent/bundles'));
    await runSwitch({ box: box(), stateDir: state, to: null }, deps());
    const after = readdirSync(join(state, 'key-agent/bundles'));
    expect(after).toHaveLength(2);
    expect(after.filter((n) => !before.includes(n))).toHaveLength(1);
    expect(duringDeploy?.previous).toBe(false);
    expect(bundleProviders()).toEqual(['file', 'file']);
  });

  it('dry run, an .env override and an unchanged target all leave the box as it was', async () => {
    const snapshot = () => [
      read('choice.json'),
      read('agent.env'),
      readdirSync(join(state, 'key-agent/bundles')).join(),
    ];
    const before = snapshot();
    await runSwitch({ box: box(), stateDir: state, to: 'gcp-kms', dryRun: true }, deps());
    expect(logs.join('\n')).toContain('dry run: nothing was changed');
    await expect(
      runSwitch(
        { box: { ...box(), SAM_KEY_PROVIDER: 'file' }, stateDir: state, to: 'gcp-kms' },
        deps()
      )
    ).rejects.toThrow(/remove that line first/);
    await expect(runSwitch({ box: box(), stateDir: state, to: 'file' }, deps())).rejects.toThrow(
      /already seals with file/
    );
    expect(snapshot()).toEqual(before);
    expect(steps).toEqual([]);
  });
});
