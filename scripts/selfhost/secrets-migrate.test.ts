/**
 * `pnpm selfhost:secrets migrate` (secrets-migrate.ts) with the real `deploy.ts --init` (a child
 * process on a throwaway box) and the real contract check (the agent's code answering the
 * Worker's real loader). The steps that need a running box (compose, the deploy, celld's reload
 * and the bucket) are recorded fakes, so each failure point can be driven.
 */
import { randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, CLOSED_HOST, runDeploy, writeBox } from './deploy-harness.js';
import { ensurePlatformKeys } from './platform-keys.js';
import { parseDotenv } from './secret-files.js';
import { type MigrateDeps, runMigration } from './secrets-migrate.js';
import { preflightSealedSecrets } from './secrets-preflight.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

const NO_CLOUD = [
  `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
  `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
  `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
];
/** Generated per run: no secret-looking literal in the source. */
const OPERATOR = `GITHUB_CLIENT_SECRET=${randomBytes(16).toString('hex')}\n`;

let dir: string;
let state: string;
let envFile: string;
let steps: string[];
let logs: string[];

function box(): Record<string, string> {
  return parseDotenv(readFileSync(envFile, 'utf8'), envFile);
}

function deps(overrides: Partial<MigrateDeps> = {}): MigrateDeps {
  return {
    log: (message) => logs.push(message),
    init: async () => {
      steps.push('init');
      const result = await runDeploy(envFile, ['--init']);
      if (result.status !== 0) throw new Error(result.out);
    },
    preflight: async (input) => {
      steps.push('preflight');
      return await preflightSealedSecrets(input);
    },
    startStack: async () => {
      steps.push('compose up');
    },
    deploy: async (legacy) => {
      steps.push(legacy ? 'deploy legacy' : 'deploy sealed');
    },
    adoptAndCheck: async () => {
      steps.push('reload+health');
      return { healthy: true, detail: 'HTTP 200' };
    },
    currentVersionSecrets: async () => {
      steps.push('scan current');
      // Before the sealed deploy the running version still has its secret vars.
      return steps.includes('deploy sealed') ? [] : ['ENCRYPTION_KEY'];
    },
    ...overrides,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-migrate-'));
  state = join(dir, '.state');
  envFile = writeBox(dir, NO_CLOUD);
  mkdirSync(state, { mode: 0o700 });
  ensurePlatformKeys(join(state, 'platform-keys.json'));
  writeFileSync(join(state, 'secrets.env'), OPERATOR, { mode: 0o600 });
  steps = [];
  logs = [];
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const plaintextLeft = () =>
  ['platform-keys.json', 'secrets.env'].filter((f) => existsSync(join(state, f)));

describe('secrets migrate', () => {
  it('seals, checks the contract, switches, verifies, then removes the files once a key copy matches', async () => {
    const kept = await runMigration({ box: box(), stateDir: state }, deps());
    expect(kept).toBe('migrated-files-kept');
    expect(steps).toEqual([
      'init',
      'preflight',
      'compose up',
      'scan current',
      'deploy sealed',
      'reload+health',
      'scan current',
    ]);
    // File key and no proven copy: the plaintext files are the only other copy, so they stay,
    // and the notice is the last thing the operator reads.
    expect(plaintextLeft()).toEqual(['platform-keys.json', 'secrets.env']);
    expect(logs.join('\n')).toContain('KEY FILE CREATED');
    expect(logs.at(-1)).toContain('pnpm selfhost:secrets migrate --key-copy');

    const copy = join(dir, 'kek-copy');
    writeFileSync(copy, readFileSync(join(state, 'key-agent/kek')), { mode: 0o600 });
    steps = [];
    const done = await runMigration(
      { box: box(), stateDir: state, keyCopy: copy },
      deps({
        // The sealed version is already current from the first run.
        currentVersionSecrets: async () => {
          steps.push('scan current');
          return [];
        },
      })
    );
    expect(done).toBe('migrated');
    // No second switch: verified what runs, then removed.
    expect(steps).toEqual(['init', 'preflight', 'compose up', 'scan current', 'reload+health']);
    expect(plaintextLeft()).toEqual([]);
    const kek = readFileSync(join(state, 'key-agent/kek'), 'utf8').trim();
    expect(logs.join('\n')).not.toContain(kek);
  });

  it('a key copy that does not match keeps the files', async () => {
    const wrong = join(dir, 'wrong');
    writeFileSync(wrong, Buffer.alloc(32, 9).toString('base64'), { mode: 0o600 });
    expect(await runMigration({ box: box(), stateDir: state, keyCopy: wrong }, deps())).toBe(
      'migrated-files-kept'
    );
    expect(plaintextLeft()).toHaveLength(2);
    expect(logs.join('\n')).toContain('does NOT match');
  });

  it('stops before switching when the contract check fails (nothing deployed, nothing removed)', async () => {
    const failing = deps({
      preflight: async (input) => {
        steps.push('preflight');
        // The Worker must get every plaintext value back unchanged; ask for one it cannot.
        return await preflightSealedSecrets({
          ...input,
          expected: { ...input.expected, GITHUB_CLIENT_SECRET: 'a-different-value' },
        });
      },
    });
    await expect(runMigration({ box: box(), stateDir: state }, failing)).rejects.toThrow(
      /would not get these secrets unchanged: GITHUB_CLIENT_SECRET/
    );
    expect(steps).toEqual(['init', 'preflight']);
    expect(plaintextLeft()).toHaveLength(2);
  });

  it('rolls back when the first request to the new version is not healthy', async () => {
    let checks = 0;
    const unhealthy = deps({
      adoptAndCheck: async () => {
        steps.push('reload+health');
        checks += 1;
        return checks === 1
          ? { healthy: false, detail: 'HTTP 503 KEY_AGENT_BAD_RESPONSE' }
          : { healthy: true, detail: 'HTTP 200' };
      },
    });
    await expect(runMigration({ box: box(), stateDir: state }, unhealthy)).rejects.toThrow(
      /rolled back: the new version is not healthy: HTTP 503 KEY_AGENT_BAD_RESPONSE/
    );
    expect(steps.slice(-4)).toEqual([
      'deploy sealed',
      'reload+health',
      'deploy legacy',
      'reload+health',
    ]);
    expect(plaintextLeft()).toHaveLength(2);
    expect(logs.join('\n')).toContain(
      'rolled back: the install runs on plaintext deploy vars again'
    );
  });

  it('rolls back when the deployed version still holds secret vars', async () => {
    const leaky = deps({
      currentVersionSecrets: async () => {
        steps.push('scan current');
        return ['ENCRYPTION_KEY'];
      },
    });
    await expect(runMigration({ box: box(), stateDir: state }, leaky)).rejects.toThrow(
      /still holds secret vars: ENCRYPTION_KEY/
    );
    expect(steps.at(-2)).toBe('deploy legacy');
    expect(plaintextLeft()).toHaveLength(2);
  });

  it('refuses while .env says legacy-plaintext, and has nothing to do on a sealed box', async () => {
    envFile = writeBox(dir, [...NO_CLOUD, 'SAM_KEY_PROVIDER=legacy-plaintext']);
    await expect(runMigration({ box: box(), stateDir: state }, deps())).rejects.toThrow(
      /remove that line/
    );
    envFile = writeBox(dir, NO_CLOUD);
    rmSync(join(state, 'platform-keys.json'));
    expect(await runMigration({ box: box(), stateDir: state }, deps())).toBe('nothing-to-migrate');
    expect(steps).toEqual([]);
  });
});
