/**
 * A box already running on plaintext deploy vars stays on them unless sealing is asked for.
 *
 * Box round on #2933: `pnpm selfhost:upgrade` from main (before sealing) to the sealing head ran
 * the target's `selfhost:deploy --init` with no key flag (main's upgrader knows none). That --init
 * chose Cloud KMS and sealed the plaintext box outside `secrets migrate`; the key agent had no
 * SAM_KEY_AGENT_UID yet, `docker compose up` failed and the upgrade rolled back. Every existing
 * plaintext box upgrading to this version would do the same. Driven through the real deploy entry
 * exactly as main's upgrader calls it.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, noStackDocker, runDeploy, writeBox } from './deploy-harness.js';
import { ensurePlatformKeys } from './platform-keys.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });

let dir: string;
let state: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-hold-plaintext-'));
  state = join(dir, '.state');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

/** A box deployed before sealing: plaintext platform keys and secrets.env, no key choice. */
function plaintextBox(extra: string[] = []): string {
  const envFile = writeBox(dir, extra);
  mkdirSync(state, { recursive: true, mode: 0o700 });
  ensurePlatformKeys(state, 'init');
  writeFileSync(join(state, 'secrets.env'), 'GITHUB_CLIENT_SECRET=plain-held-secret-value\n', {
    mode: 0o600,
  });
  return envFile;
}

const keyAgent = (path = '') => join(state, 'key-agent', path);
const bundles = () =>
  existsSync(keyAgent('bundles')) ? readdirSync(keyAgent('bundles')) : ([] as string[]);

describe('a box on plaintext deploy vars', () => {
  it('stays plaintext through the --init an older upgrader runs, with the agent env compose needs', async () => {
    const envFile = plaintextBox();
    const env = noStackDocker(dir);
    const init = await runDeploy(envFile, ['--init'], env);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain('stays on them; `pnpm selfhost:secrets migrate` seals it safely');
    expect(existsSync(keyAgent('choice.json'))).toBe(false);
    expect(bundles()).toEqual([]);
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
    // docker compose reads this env_file for the key-agent service: it must exist, and say legacy.
    expect(readFileSync(keyAgent('agent.env'), 'utf8')).toContain(
      'SAM_KEY_PROVIDER=legacy-plaintext'
    );

    // The upgrader's following deploy (no --init) also stays plaintext.
    const dry = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent'], env);
    expect(dry.status, dry.out).toBe(0);
    expect(dry.out).not.toContain('SAM_KEY_AGENT_ADDRESS');
  });

  it('control: --seal (what secrets migrate passes) seals it', async () => {
    const envFile = plaintextBox();
    const init = await runDeploy(envFile, ['--init', '--seal'], noStackDocker(dir));
    expect(init.status, init.out).toBe(0);
    expect(existsSync(keyAgent('choice.json'))).toBe(true);
    expect(bundles()).toHaveLength(1);
  });

  it('control: a fresh box (no platform keys yet) is sealed by default', async () => {
    const envFile = writeBox(dir);
    const init = await runDeploy(envFile, ['--init'], noStackDocker(dir));
    expect(init.status, init.out).toBe(0);
    expect(existsSync(keyAgent('choice.json'))).toBe(true);
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
  });
});
