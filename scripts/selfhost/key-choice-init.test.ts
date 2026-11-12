/**
 * Sealed secrets by default, through the real entry point: `tsx deploy.ts --init` and
 * `--dry-run` as child processes on a throwaway `.env` and `.state/`, exactly as an operator runs
 * them. Covers the default (no SAM_KEY_PROVIDER), the explicit legacy override, a plain deploy
 * with no recorded choice, and a legacy box whose plaintext files get sealed unchanged.
 */
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
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
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openBundle, parseBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import { createFileProvider } from '../../deploy/selfhost/key-agent/provider-file.ts';
import {
  CHILD_TEST_TIMEOUT_MS,
  CLOSED_HOST,
  runDeploy,
  runTsx,
  writeBox as write,
} from './deploy-harness.js';

vi.setConfig({ testTimeout: CHILD_TEST_TIMEOUT_MS });
import { ensurePlatformKeys } from './platform-keys.js';

/** Generated per run: no secret-looking literal in the source. */
const OPERATOR_SECRET = randomBytes(16).toString('hex');
let dir: string;
let state: string;

const NO_CLOUD = [
  `SAM_GCE_METADATA_HOST=${CLOSED_HOST}`,
  `SAM_AWS_IMDS_HOST=${CLOSED_HOST}`,
  `SAM_AZURE_IMDS_HOST=${CLOSED_HOST}`,
];
const writeBox = (target: string, extra: string[] = []) => write(target, [...NO_CLOUD, ...extra]);

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

async function dryRunVars(envFile: string): Promise<Record<string, string>> {
  const result = await runDeploy(envFile, ['--dry-run', '--skip-vm-agent']);
  expect(result.status, result.out).toBe(0);
  const json = result.out.slice(result.out.indexOf('{\n'));
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
    const init = await runDeploy(envFile, ['--init']);
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

    const vars = await dryRunVars(envFile);
    expect(vars.SAM_KEY_AGENT_URL).toBe('http://127.0.0.1:7190/v1/secrets');
    const rendered = JSON.stringify(vars);
    for (const [name, value] of Object.entries(secrets)) {
      if (name === 'SAM_INSTALLATION_ID') continue;
      expect(rendered, name).not.toContain(value);
    }
  });

  it('keeps the recorded choice on a second --init, and prints it on every deploy', async () => {
    const envFile = writeBox(dir);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    const first = choice();
    const again = await runDeploy(envFile, ['--init']);
    expect(again.status, again.out).toBe(0);
    expect(choice()).toEqual(first);
    expect(bundles()).toHaveLength(1);
    expect((await runDeploy(envFile, ['--dry-run', '--skip-vm-agent'])).out).toContain(
      'key provider: file'
    );
  });

  it('refuses a plain deploy when no provider was ever chosen', async () => {
    const result = await runDeploy(writeBox(dir), ['--dry-run', '--skip-vm-agent']);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('pnpm selfhost:deploy --init');
    expect(existsSync(join(state, 'key-agent/choice.json'))).toBe(false);
  });

  it('legacy-plaintext keeps the old behaviour: plaintext keys file, secrets as deploy vars', async () => {
    const envFile = writeBox(dir, ['SAM_KEY_PROVIDER=legacy-plaintext']);
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(init.out).toContain('stored in plaintext in the fleet bucket');
    expect(bundles()).toEqual([]);
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(true);
    expect(readFileSync(join(state, 'key-agent/agent.env'), 'utf8')).toContain(
      'SAM_KEY_PROVIDER=legacy-plaintext'
    );
    expect(readFileSync(join(state, 'egress-fence.nft'), 'utf8')).not.toContain('7190');
    const vars = await dryRunVars(envFile);
    expect(vars.ENCRYPTION_KEY).toBe('<redacted>');
    expect(vars.SAM_KEY_AGENT_URL).toBeUndefined();
  });

  it('refuses the spike-era `off` with the new name', async () => {
    const result = await runDeploy(writeBox(dir, ['SAM_KEY_PROVIDER=off']), ['--init']);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('legacy-plaintext');
  });

  it('seals an existing plaintext install unchanged (its keys and secrets.env)', async () => {
    const envFile = writeBox(dir);
    mkdirSync(state, { mode: 0o700 });
    const legacy = ensurePlatformKeys(join(state, 'platform-keys.json')).keys;
    writeFileSync(join(state, 'secrets.env'), `GITHUB_CLIENT_SECRET=${OPERATOR_SECRET}\n`, {
      mode: 0o600,
    });
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    const secrets = await sealedSecrets();
    expect(secrets.ENCRYPTION_KEY).toBe(legacy.ENCRYPTION_KEY);
    expect(secrets.JWT_PRIVATE_KEY).toBe(legacy.JWT_PRIVATE_KEY);
    expect(secrets.GITHUB_CLIENT_SECRET).toBe(OPERATOR_SECRET);
  });

  it('a box whose bundles exist but whose choice record is gone keeps their provider', async () => {
    const envFile = writeBox(dir);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    rmSync(join(state, 'key-agent/choice.json'));
    const init = await runDeploy(envFile, ['--init']);
    expect(init.status, init.out).toBe(0);
    expect(choice()).toMatchObject({ provider: 'file', source: 'existing-bundle' });
    expect(bundles()).toHaveLength(1);
  });

  it('selfhost:secrets status shows the provider, why, the key file and bundles, no key material', async () => {
    const envFile = writeBox(dir);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    const status = await runTsx(join(import.meta.dirname, 'secrets.ts'), [
      'status',
      '--box-env',
      envFile,
    ]);
    expect(status.status, status.out).toBe(0);
    expect(status.out).toContain('key provider: file');
    expect(status.out).toContain('why:        no cloud instance identity was detected');
    expect(status.out).toContain(`key file:   ${join(state, 'key-agent/kek')}`);
    expect(status.out).toMatch(/bundles: 1\n {2}[0-9a-f]{32} /);
    const kek = readFileSync(join(state, 'key-agent/kek'), 'utf8').trim();
    expect(status.out).not.toContain(kek);
    for (const value of Object.values(await sealedSecrets())) {
      if (value.length >= 16) expect(status.out).not.toContain(value);
    }
  });

  it('refuses legacy-plaintext on a sealed box (it would generate new platform keys)', async () => {
    const envFile = writeBox(dir);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    const sealed = await sealedSecrets();
    writeBox(dir, ['SAM_KEY_PROVIDER=legacy-plaintext']);
    const result = await runDeploy(envFile, ['--init']);
    expect(result.status).not.toBe(0);
    expect(result.out).toContain('lose every stored credential');
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
    expect((await sealedSecrets()).ENCRYPTION_KEY).toBe(sealed.ENCRYPTION_KEY);
    // The refused override left the recorded choice alone: removing the line just works again.
    expect(choice()).toMatchObject({ provider: 'file', source: 'auto' });
    writeBox(dir);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
  });

  it('tells the operator once, at the first seal, to keep the key file off the box', async () => {
    const envFile = writeBox(dir);
    const first = await runDeploy(envFile, ['--init']);
    expect(first.out).toContain(`KEY FILE CREATED: ${join(state, 'key-agent/kek')}`);
    expect(first.out).toContain('cannot be recovered from a backup');
    const second = await runDeploy(envFile, ['--init']);
    expect(second.out).not.toContain('KEY FILE CREATED');
    const kek = readFileSync(join(state, 'key-agent/kek'), 'utf8').trim();
    expect(first.out).not.toContain(kek);
  });

  it('key-file and verify-key-copy: say where the key is, check a copy, never print it', async () => {
    const envFile = writeBox(dir);
    expect((await runDeploy(envFile, ['--init'])).status).toBe(0);
    const secrets = join(import.meta.dirname, 'secrets.ts');
    const kek = readFileSync(join(state, 'key-agent/kek'), 'utf8').trim();
    const where = await runTsx(secrets, ['key-file', '--box-env', envFile]);
    expect(where.status, where.out).toBe(0);
    expect(where.out).toContain(`key file:    ${join(state, 'key-agent/kek')}`);
    expect(where.out).toMatch(/fingerprint: sha256:[0-9a-f]{32}/);
    expect(where.out).toContain('mode:        600');

    const good = join(dir, 'copy-good');
    writeFileSync(good, `${kek}\n`, { mode: 0o600 });
    const bad = join(dir, 'copy-bad');
    writeFileSync(bad, Buffer.alloc(32, 7).toString('base64'), { mode: 0o600 });
    const matches = await runTsx(secrets, ['verify-key-copy', good, '--box-env', envFile]);
    expect(matches.status, matches.out).toBe(0);
    expect(matches.out).toContain('matches the box');
    const differs = await runTsx(secrets, ['verify-key-copy', bad, '--box-env', envFile]);
    expect(differs.status).toBe(1);
    expect(differs.out).toContain('does NOT match');
    // A relative path is taken from where the operator ran pnpm (INIT_CWD), not the repo root.
    const relative = spawnSync(
      'pnpm',
      [
        '--dir',
        join(import.meta.dirname, '../..'),
        'selfhost:secrets',
        'verify-key-copy',
        'copy-good',
        '--box-env',
        envFile,
      ],
      { cwd: dir, encoding: 'utf8' }
    );
    expect(relative.status, `${relative.stdout}${relative.stderr}`).toBe(0);
    expect(relative.stdout).toContain('matches the box');
    for (const out of [where.out, matches.out, differs.out]) expect(out).not.toContain(kek);
  });
});
