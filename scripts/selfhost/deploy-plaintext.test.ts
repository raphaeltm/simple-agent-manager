/**
 * `pnpm selfhost:deploy --init` and `--dry-run` run as child processes on a throwaway `.env` and
 * `.state/`, exactly as an operator runs them (deploy-harness.ts). This is the plaintext path end to
 * end, short of `celld deploy`: --init generates the platform keys and gateway.env once, and the
 * config celld would store carries every secret as a Worker var, redacted in the printed copy.
 */
import { randomBytes } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { CHILD_TEST_TIMEOUT_MS, runDeploy, writeBox } from './deploy-harness.js';
import { PLATFORM_KEY_NAMES, PLATFORM_KEYS_FILE } from './platform-keys.js';

// Generated per run so no secret-shaped literal sits in the tree.
const OPERATOR_SECRET = randomBytes(16).toString('hex');
let dir: string;
let state: string;

function writeSecrets(lines: string[]): void {
  writeFileSync(join(state, 'secrets.env'), `${lines.join('\n')}\n`, { mode: 0o600 });
}

async function dryRun(envFile: string): Promise<{ out: string; config: Record<string, unknown> }> {
  const result = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
  expect(result.status, result.out).toBe(0);
  return {
    out: result.out,
    config: JSON.parse(result.out.slice(result.out.indexOf('{\n'))) as Record<string, unknown>,
  };
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-deploy-'));
  state = join(dir, '.state');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('selfhost:deploy, plaintext', { timeout: CHILD_TEST_TIMEOUT_MS }, () => {
  it('--init writes the platform keys and gateway.env once; --dry-run renders them as redacted vars', async () => {
    const envFile = writeBox(dir);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    const keysPath = join(state, PLATFORM_KEYS_FILE);
    expect(statSync(keysPath).mode & 0o777).toBe(0o600);
    const keys = JSON.parse(readFileSync(keysPath, 'utf8')) as Record<string, string>;
    expect(Object.keys(keys).sort()).toEqual([...PLATFORM_KEY_NAMES].sort());
    expect(readFileSync(join(state, 'gateway.env'), 'utf8')).toContain(
      keys.REVERSE_TUNNEL_GATEWAY_SECRET
    );

    // A second --init keeps every key.
    const before = readFileSync(keysPath, 'utf8');
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    expect(readFileSync(keysPath, 'utf8')).toBe(before);

    writeSecrets([`GITHUB_CLIENT_SECRET=${OPERATOR_SECRET}`]);
    const { out, config } = await dryRun(envFile);
    const vars = config.vars as Record<string, string>;
    for (const name of PLATFORM_KEY_NAMES.filter((n) => n !== 'SAM_INSTALLATION_ID')) {
      expect(vars[name], name).toBe('<redacted>');
      expect(out).not.toContain(keys[name]);
    }
    expect(vars.GITHUB_CLIENT_SECRET).toBe('<redacted>');
    expect(out).not.toContain(OPERATOR_SECRET);
    // An identifier, not a secret: the ownership label every node VM carries.
    expect(vars.SAM_INSTALLATION_ID).toBe(keys.SAM_INSTALLATION_ID);
    expect(vars.ENVIRONMENT).toBe('selfhost');
    expect(vars.BASE_DOMAIN).toBe('sam.example.com');
    // The plaintext path is the only one: no key agent, no containers.
    expect(Object.keys(vars).filter((name) => name.startsWith('SAM_KEY_'))).toEqual([]);
    expect(config).not.toHaveProperty('containers');
    expect(config.main).toBe('celld-main.ts');
  });

  it('refuses a state dir whose platform keys are sealed, and writes no new keys', async () => {
    const envFile = writeBox(dir);
    mkdirSync(join(state, 'key-agent', 'bundles'), { recursive: true });
    writeFileSync(join(state, 'key-agent', 'bundles', 'b1.json'), '{}');
    const result = await runDeploy(envFile, ['--init']);
    expect(result.status).toBe(1);
    expect(result.out).toContain('platform keys are sealed');
    expect(existsSync(join(state, PLATFORM_KEYS_FILE))).toBe(false);
  });

  it('refuses an s3:// operator store without R2_S3_REGION, and passes one through', async () => {
    const endpoint = 'R2_S3_ENDPOINT=https://s3.example.com';
    const without = writeBox(dir, [endpoint]);
    expect((await runDeploy(without, ['--init'])).status).toBe(0);
    const refused = await runDeploy(without, ['--dry-run', '--skip-vm-agent']);
    expect(refused.status).toBe(1);
    expect(refused.out).toContain('R2_S3_REGION is required');

    const withRegion = writeBox(dir, [endpoint, 'R2_S3_REGION=us-east-1']);
    const vars = (await dryRun(withRegion)).config.vars as Record<string, string>;
    expect(vars.R2_S3_REGION).toBe('us-east-1');
    expect(vars.R2_S3_ENDPOINT).toBe('https://s3.example.com');
  });

  it('refuses secrets.env setting a var the deployment generates', async () => {
    const envFile = writeBox(dir);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    writeSecrets(['VM_AGENT_REQUIRED_VERSION=pinned-by-hand']);
    const result = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
    expect(result.status).toBe(1);
    expect(result.out).toContain('VM_AGENT_REQUIRED_VERSION is generated');
  });
});
