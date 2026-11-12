/**
 * Sealed secrets by default, through the real entry point: `tsx deploy.ts --init` and
 * `--dry-run` as child processes on a throwaway `.env` and `.state/`, exactly as an operator runs
 * them. Covers the default (no SAM_KEY_PROVIDER), the explicit legacy override, a plain deploy
 * with no recorded choice, and a legacy box whose plaintext files get sealed unchanged.
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { openBundle, parseBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import { createFileProvider } from '../../deploy/selfhost/key-agent/provider-file.ts';
import { ensurePlatformKeys } from './platform-keys.js';

const DEPLOY = resolve(import.meta.dirname, 'deploy.ts');
const BASE_ENV = [
  'SAM_DOMAIN=sam.example.com',
  'SAM_TLS_MODE=internal',
  'COMPOSE_PROFILES=tunnel,local-store',
  'CELLD_BUCKET=s3://fleet/celld',
  'S3_ENDPOINT=http://127.0.0.1:9000',
  'AWS_ACCESS_KEY_ID=fleet-key',
  'AWS_SECRET_ACCESS_KEY=fleet-secret-0123456789',
];

let dir: string;
let state: string;

export function writeBox(target: string, extra: string[] = []): string {
  const envFile = join(target, '.env');
  writeFileSync(envFile, `${[...BASE_ENV, ...extra].join('\n')}\n`, { mode: 0o600 });
  return envFile;
}

export function runDeploy(
  envFile: string,
  args: string[],
  env: NodeJS.ProcessEnv = {}
): { status: number; out: string } {
  const result = spawnSync('npx', ['tsx', DEPLOY, '--env-file', envFile, ...args], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
    timeout: 60_000,
  });
  return { status: result.status ?? 1, out: `${result.stdout}${result.stderr}` };
}

function bundles(): string[] {
  const path = join(state, 'key-agent/bundles');
  return existsSync(path) ? readdirSync(path) : [];
}

function choice(): Record<string, unknown> {
  return JSON.parse(readFileSync(join(state, 'key-agent/choice.json'), 'utf8')) as Record<
    string,
    unknown
  >;
}

async function sealedSecrets(): Promise<Record<string, string>> {
  const [name] = bundles();
  const bundle = parseBundle(readFileSync(join(state, 'key-agent/bundles', name ?? ''), 'utf8'));
  return await openBundle(
    bundle,
    createFileProvider({ SAM_KEY_FILE: join(state, 'key-agent/kek') })
  );
}

function dryRunVars(envFile: string): Record<string, string> {
  const run = runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
  expect(run.status, run.out).toBe(0);
  const json = run.out.slice(run.out.indexOf('{\n'));
  return (JSON.parse(json) as { vars: Record<string, string> }).vars;
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'sam-keyinit-'));
  state = join(dir, '.state');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('pnpm selfhost:deploy --init (sealed secrets by default)', () => {
  it('seals a new install without any setting, and says which provider and why', async () => {
    const envFile = writeBox(dir);
    const init = runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toMatch(/key provider: file \(no cloud instance identity was detected/);
    expect(choice()).toMatchObject({ provider: 'file', source: 'auto' });
    expect(bundles()).toHaveLength(1);
    // No plaintext platform keys file: they were generated straight into the bundle.
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
    const secrets = await sealedSecrets();
    expect(secrets.ENCRYPTION_KEY).toBeTruthy();
    expect(readFileSync(join(state, 'key-agent/agent.env'), 'utf8')).toContain(
      'SAM_KEY_PROVIDER=file'
    );
    // The fence opens the agent's port to celld (egress-fence.ts).
    expect(readFileSync(join(state, 'egress-fence.nft'), 'utf8')).toContain('7190');

    const vars = dryRunVars(envFile);
    expect(vars.SAM_KEY_AGENT_URL).toBe('http://127.0.0.1:7190/v1/secrets');
    const rendered = JSON.stringify(vars);
    for (const [name, value] of Object.entries(secrets)) {
      if (name === 'SAM_INSTALLATION_ID') continue;
      expect(rendered, name).not.toContain(value);
    }
  });

  it('keeps the recorded choice on a second --init, and prints it on every deploy', () => {
    const envFile = writeBox(dir);
    expect(runDeploy(envFile, ['--init']).status).toBe(0);
    const first = choice();
    const again = runDeploy(envFile, ['--init']);
    expect(again.status, again.out).toBe(0);
    expect(choice()).toEqual(first);
    expect(bundles()).toHaveLength(1);
    expect(runDeploy(envFile, ['--dry-run', '--skip-vm-agent']).out).toContain(
      'key provider: file'
    );
  });

  it('refuses a plain deploy when no provider was ever chosen', () => {
    const run = runDeploy(writeBox(dir), ['--dry-run', '--skip-vm-agent']);
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('pnpm selfhost:deploy --init');
    expect(existsSync(join(state, 'key-agent/choice.json'))).toBe(false);
  });

  it('legacy-plaintext keeps the old behaviour: plaintext keys file, secrets as deploy vars', () => {
    const envFile = writeBox(dir, ['SAM_KEY_PROVIDER=legacy-plaintext']);
    const init = runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain('stored in plaintext in the fleet bucket');
    expect(bundles()).toEqual([]);
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
    expect(readFileSync(join(state, 'key-agent/agent.env'), 'utf8')).toContain(
      'SAM_KEY_PROVIDER=legacy-plaintext'
    );
    expect(readFileSync(join(state, 'egress-fence.nft'), 'utf8')).not.toContain('7190');
    const vars = dryRunVars(envFile);
    expect(vars.ENCRYPTION_KEY).toBe('<redacted>');
    expect(vars.SAM_KEY_AGENT_URL).toBeUndefined();
  });

  it('refuses the spike-era `off` with the new name', () => {
    const run = runDeploy(writeBox(dir, ['SAM_KEY_PROVIDER=off']), ['--init']);
    expect(run.status).not.toBe(0);
    expect(run.out).toContain('legacy-plaintext');
  });

  it('seals an existing plaintext install unchanged (its keys and secrets.env)', async () => {
    const envFile = writeBox(dir);
    mkdirSync(state, { mode: 0o700 });
    const legacy = ensurePlatformKeys(join(state, 'platform-keys.json')).keys;
    writeFileSync(join(state, 'secrets.env'), 'GITHUB_CLIENT_SECRET=gh-secret-0123456789\n', {
      mode: 0o600,
    });
    const init = runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    const secrets = await sealedSecrets();
    expect(secrets.ENCRYPTION_KEY).toBe(legacy.ENCRYPTION_KEY);
    expect(secrets.JWT_PRIVATE_KEY).toBe(legacy.JWT_PRIVATE_KEY);
    expect(secrets.GITHUB_CLIENT_SECRET).toBe('gh-secret-0123456789');
  });

  it('a box whose bundles exist but whose choice record is gone keeps their provider', () => {
    const envFile = writeBox(dir);
    expect(runDeploy(envFile, ['--init']).status).toBe(0);
    rmSync(join(state, 'key-agent/choice.json'));
    const init = runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(choice()).toMatchObject({ provider: 'file', source: 'existing-bundle' });
    expect(bundles()).toHaveLength(1);
  });
});
