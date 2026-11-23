/**
 * `pnpm selfhost:secrets switch` / `reseal` (secrets-switch.ts) on a box set up by the real
 * `deploy.ts --init`, moving from the file key to Cloud KMS served by the fake (key-provider-fakes):
 * the agent's files during and after the switch, the rollback, a reseal, and a real
 * `deploy --dry-run` afterwards that runs on the new bundle.
 */
import { existsSync, mkdtempSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  CHILD_TEST_TIMEOUT_MS,
  CLOSED_HOST,
  noStackDocker,
  runDeploy as harnessRunDeploy,
  writeBox,
} from './deploy-harness.js';

/** The real deploy entry; a second `--init` on the same state sees no running stack. */
const runDeploy = (envFile: string, args: string[], env: NodeJS.ProcessEnv = {}) =>
  harnessRunDeploy(envFile, args, { ...noStackDocker(dirname(envFile)), ...env });
import { type FakeKeyService, startFakeKeyServices } from './fixtures/key-provider-fakes.js';
import { applyKeyChoice, type PlatformCandidates, readKeyChoice } from './key-choice.js';
import { resolveSealedSecrets } from './key-seal.js';
import { keyServiceSettings } from './key-service.js';
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
    const before = {
      choice: read('choice.json'),
      agentEnv: read('agent.env'),
      head: JSON.parse(read('head.json')) as { bundleId: string; seq: number },
    };
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
    // The head names the old bundle again (a later write, sealed with the old key) before the new
    // bundle went: the real deploy runs with it instead of refusing a head naming a missing bundle.
    const head = JSON.parse(read('head.json')) as { bundleId: string; seq: number };
    expect(head.bundleId).toBe(before.head.bundleId);
    expect(head.seq).toBeGreaterThan(before.head.seq);
    const dry = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).toContain(`"SAM_SECRET_BUNDLE_ID": "${before.head.bundleId}"`);
  });

  it('rolls back when its own deploy sealed a secrets.env edit under the new key', async () => {
    const before = JSON.parse(read('head.json')) as { bundleId: string; seq: number };
    let check = 0;
    const sealing: SwitchDeps = {
      ...deps(),
      // What `pnpm selfhost:deploy` does when secrets.env holds an edit not deployed yet: it
      // seals a further bundle under the key the box is configured for at that moment.
      deploy: async () => {
        const choice = readKeyChoice(state);
        const settings = choice && keyServiceSettings(applyKeyChoice(box(), choice), state);
        if (!settings) throw new Error('not sealed');
        await resolveSealedSecrets({
          settings,
          stateDir: state,
          mode: 'deploy',
          platformKeysFile: null,
          operatorSecrets: { OPERATOR_TOKEN: `edited-${check}` },
        });
      },
      adoptAndCheck: async () => {
        const ok = check++ > 0;
        return { healthy: ok, detail: ok ? 'HTTP 200' : 'HTTP 503' };
      },
    };
    await expect(
      runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, sealing)
    ).rejects.toThrow(/switch rolled back: the new version is not healthy: HTTP 503/);
    // The box is back on the key file and the head agrees with it: the next deploy runs.
    expect(JSON.parse(read('choice.json'))).toMatchObject({ provider: 'file' });
    const head = JSON.parse(read('head.json')) as { seq: number; seal: { provider: string } };
    expect(head.seal.provider).toBe('file');
    expect(head.seq).toBeGreaterThan(before.seq);
    const dry = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
    expect(dry.status, dry.out).toBe(0);
  });

  it('refuses a target that cannot unwrap, and changes nothing', async () => {
    fake.setDenied(true);
    await expect(runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, deps())).rejects.toThrow(
      /gcp-kms .* is not usable: denied/
    );
    expect(bundleProviders()).toEqual(['file']);
    expect(steps).toEqual([]);
  });

  it('switch --to auto never goes down: a Cloud KMS box is not moved to the key file', async () => {
    await runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, deps());
    steps = [];
    logs = [];
    const before = [read('choice.json'), readdirSync(join(state, 'key-agent/bundles')).join()];
    // The automatic choice on this box would find no cloud key (the conventional one does not
    // exist): on a new box that means the key file, but this box is sealed with Cloud KMS now.
    const absent = {
      ...deps(),
      detect: async (): Promise<PlatformCandidates> => ({
        platform: 'Google Cloud (project sam-fake-project)',
        candidates: [
          {
            provider: 'gcp-kms',
            settings: { SAM_GCP_KMS_KEY: 'projects/x/no-such-key' },
            label: 'Cloud KMS key projects/x/no-such-key',
          },
        ],
      }),
    };
    await expect(runSwitch({ box: box(), stateDir: state, to: 'auto' }, absent)).rejects.toThrow(
      /refusing to seal this box's secrets with a key file on this box: this box is sealed with gcp-kms now/
    );
    expect([read('choice.json'), readdirSync(join(state, 'key-agent/bundles')).join()]).toEqual(
      before
    );
    expect(steps).toEqual([]);
    // Moving down on purpose stays possible.
    const down = await runSwitch({ box: box(), stateDir: state, to: 'file' }, deps());
    expect(down.provider).toBe('file');
  });

  // Codex P2 on #2933: a box sealed only with a cloud key has no key file, and switching it to the
  // file key used to fail as "the key file was lost".
  it('moves a box sealed only with Cloud KMS to a new key file', async () => {
    await runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, deps());
    const bundles = join(state, 'key-agent/bundles');
    const fileBundle = readdirSync(bundles).find((n) => read(`bundles/${n}`).includes('"file"'));
    rmSync(join(bundles, fileBundle ?? ''));
    rmSync(join(state, 'key-agent/kek'));
    const down = await runSwitch({ box: box(), stateDir: state, to: 'file' }, deps());
    expect(down.provider).toBe('file');
    expect(existsSync(join(state, 'key-agent/kek'))).toBe(true);
    expect(bundleProviders()).toEqual(['file', 'gcp-kms']);
    // The lost-key refusal itself is pinned in key-service.test.ts.
  });

  // Codex P1 on #2933: creating the key file used to rewrite agent.env for the file key before the
  // switch saved it, so a failed switch "restored" the file-key env and the old bundle could not
  // be opened.
  it('a failed switch from Cloud KMS to a new key file restores the Cloud KMS agent', async () => {
    await runSwitch({ box: box(), stateDir: state, to: 'gcp-kms' }, deps());
    const bundles = join(state, 'key-agent/bundles');
    const fileBundle = readdirSync(bundles).find((n) => read(`bundles/${n}`).includes('"file"'));
    rmSync(join(bundles, fileBundle ?? ''));
    rmSync(join(state, 'key-agent/kek'));
    const before = { choice: read('choice.json'), agentEnv: read('agent.env') };
    expect(before.agentEnv).toContain(`SAM_GCP_KMS_KEY=${GCP_KEY}`);
    steps = [];
    await expect(
      runSwitch({ box: box(), stateDir: state, to: 'file' }, deps([false, true]))
    ).rejects.toThrow(/switch rolled back/);
    expect(read('agent.env')).toBe(before.agentEnv);
    expect(read('choice.json')).toBe(before.choice);
    expect(bundleProviders()).toEqual(['gcp-kms']);
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
