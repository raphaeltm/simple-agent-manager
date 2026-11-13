/**
 * Sealed secrets on the deploy side (key-service.ts): first install, migration from the plain
 * files, platform-key conflict refusal, operator edits, bundle retention, and the two copies that
 * leave the box: the config celld stores in the fleet bucket, and a backup. The real-runtime
 * version is live/key-agent-celld.live.test.ts.
 */
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import * as TOML from '@iarna/toml';
import { beforeEach, describe, expect, it } from 'vitest';

import { openBundle, parseBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import { createFileProvider } from '../../deploy/selfhost/key-agent/provider-file.ts';
import type { WranglerToml } from '../deploy/types.js';
import { type BoxContext, OBJECTSTORE_IMAGE, runBackup, type RunResult } from './backup-lib';
import { buildCelldConfig } from './celld-config.js';
import { renderPlainMain, renderRuntimeSecretsMain } from './celld-project.js';
import { buildFencePlan } from './egress-fence.js';
import {
  agentVerifyKey,
  celldDeployConfig,
  ensureKeyServiceFiles,
  keyAgentUrl,
  keyServiceSettings,
  listBundles,
  renderKeyAgentEnv,
  resolveSealedSecrets,
} from './key-service.js';
import { ensurePlatformKeys, PLATFORM_KEY_NAMES } from './platform-keys.js';

const uid = String(process.getuid?.() ?? 0);
let state: string;
const box = (extra: Record<string, string> = {}) => ({
  SAM_KEY_PROVIDER: 'file',
  SAM_KEY_AGENT_UID: uid,
  ...extra,
});
const OPERATOR = {
  GITHUB_CLIENT_SECRET: 'gh-client-secret-0123456789abcdef',
  GITHUB_APP_PRIVATE_KEY:
    '-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBgkqhkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----',
  SMTP_PASSWORD: 'smtp-password-0123456789',
};

function settings() {
  const s = keyServiceSettings(box(), state);
  if (!s) throw new Error('key service off');
  ensureKeyServiceFiles(s);
  return s;
}

function filesUnder(dir: string): string[] {
  if (!existsSync(dir)) return [];
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

/** Every secret value, raw and in the encodings a careless copy might use. */
function leaks(text: string, secrets: Record<string, string>): string[] {
  const found: string[] = [];
  for (const [name, value] of Object.entries(secrets)) {
    if (name === 'SAM_INSTALLATION_ID' || value.length < 8) continue;
    const forms = [
      value,
      Buffer.from(value).toString('base64'),
      JSON.stringify(value).slice(1, -1),
    ];
    if (forms.some((form) => text.includes(form))) found.push(name);
  }
  return found;
}

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'sam-keysvc-'));
});

describe('settings', () => {
  it('is off only for legacy-plaintext (or no provider at all), and refuses an unknown one', () => {
    expect(keyServiceSettings({}, state)).toBeNull();
    expect(keyServiceSettings({ SAM_KEY_PROVIDER: 'legacy-plaintext' }, state)).toBeNull();
    expect(() => keyServiceSettings(box({ SAM_KEY_PROVIDER: 'off' }), state)).toThrow(/one of/);
    expect(() => keyServiceSettings(box({ SAM_KEY_PROVIDER: 'aws' }), state)).toThrow(/one of/);
  });

  it('accepts no SAM_KEY_AGENT_UID (the agent drops to the state owner), refuses a wrong one', () => {
    expect(keyServiceSettings({ SAM_KEY_PROVIDER: 'file' }, state)?.provider).toBe('file');
    expect(() =>
      keyServiceSettings({ SAM_KEY_PROVIDER: 'file', SAM_KEY_AGENT_UID: `${uid}1` }, state)
    ).toThrow(/SAM_KEY_AGENT_UID/);
  });

  it('writes the agent env with container paths and no secret, and the KEK once (0600)', () => {
    const s = settings();
    const kek = readFileSync(join(state, 'key-agent/kek'), 'utf8');
    expect(statSync(join(state, 'key-agent/kek')).mode & 0o077).toBe(0);
    ensureKeyServiceFiles(s);
    expect(readFileSync(join(state, 'key-agent/kek'), 'utf8')).toBe(kek);
    const env = renderKeyAgentEnv(s);
    expect(env).toContain('SAM_KEY_FILE=/etc/sam/key-agent/kek');
    expect(env).not.toContain(kek.trim());
    expect(keyAgentUrl(s)).toBe('http://127.0.0.1:7190/v1/secrets');
  });
});

describe('resolveSealedSecrets', () => {
  it('first install: generates the platform keys straight into a bundle, no plaintext file', async () => {
    const r = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: null,
      operatorSecrets: OPERATOR,
    });
    expect(r.sealed).toBe(true);
    expect(r.generated).toEqual(expect.arrayContaining(['ENCRYPTION_KEY', 'JWT_PRIVATE_KEY']));
    for (const name of PLATFORM_KEY_NAMES) expect(r.secrets[name]).toBeTruthy();
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
    const [bundle] = listBundles(join(state, 'key-agent/bundles'));
    expect(bundle?.bundleId).toBe(r.bundleId);
    expect(
      leaks(readFileSync(join(state, `key-agent/bundles/${r.bundleId}.json`), 'utf8'), r.secrets)
    ).toEqual([]);
  });

  it('migration: seals the existing plain files unchanged, then needs neither file', async () => {
    const legacy = ensurePlatformKeys(join(state, 'platform-keys.json')).keys;
    const first = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: legacy,
      operatorSecrets: OPERATOR,
    });
    expect(first.generated).toEqual(['SAM_KEY_AGENT_SIGNING_KEY']);
    for (const name of PLATFORM_KEY_NAMES) expect(first.secrets[name]).toBe(legacy[name]);
    expect(first.secrets.GITHUB_CLIENT_SECRET).toBe(OPERATOR.GITHUB_CLIENT_SECRET);
    // Same inputs again: the same bundle, no reseal (no key-service call to wrap).
    const again = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: legacy,
      operatorSecrets: OPERATOR,
    });
    expect(again).toMatchObject({ bundleId: first.bundleId, sealed: false });
    // The operator retires the plaintext: the deploy runs from the bundle alone, nothing regenerated.
    rmSync(join(state, 'platform-keys.json'));
    const retired = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: null,
      operatorSecrets: {},
    });
    expect(retired).toMatchObject({ bundleId: first.bundleId, sealed: false, generated: [] });
    expect(retired.secrets).toEqual(first.secrets);
  });

  it('refuses a platform-keys.json that disagrees with the bundle (no silent key rotation)', async () => {
    const first = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: null,
      operatorSecrets: {},
    });
    const stale = { ...first.secrets, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    await expect(
      resolveSealedSecrets({ settings: settings(), platformKeysFile: stale, operatorSecrets: {} })
    ).rejects.toThrow(/ENCRYPTION_KEY .* differs from the sealed bundle/);
    // Control: the agreeing file is accepted.
    await expect(
      resolveSealedSecrets({
        settings: settings(),
        platformKeysFile: first.secrets,
        operatorSecrets: {},
      })
    ).resolves.toMatchObject({ bundleId: first.bundleId });
  });

  it('an operator edit seals a new bundle (new data key); the last three are kept', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await resolveSealedSecrets({
        settings: settings(),
        platformKeysFile: null,
        operatorSecrets: { GITHUB_CLIENT_SECRET: `rotated-secret-${i}-abcdef` },
      });
      ids.push(r.bundleId);
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(new Set(ids).size).toBe(5);
    const kept = listBundles(join(state, 'key-agent/bundles')).map((b) => b.bundleId);
    expect(kept).toEqual(ids.slice(2).reverse());
    const newest = listBundles(join(state, 'key-agent/bundles'))[0];
    const wrappedKeys = new Set(
      listBundles(join(state, 'key-agent/bundles')).map((b) => b.wrappedKey)
    );
    expect(wrappedKeys.size).toBe(3);
    if (!newest) throw new Error('no bundle');
    const opened = await openBundle(
      newest,
      createFileProvider({ SAM_KEY_FILE: join(state, 'key-agent/kek') })
    );
    expect(opened.GITHUB_CLIENT_SECRET).toBe('rotated-secret-4-abcdef');
  });

  it('refuses a bundle sealed for a different key before calling any service', async () => {
    const r = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: null,
      operatorSecrets: {},
    });
    rmSync(join(state, 'key-agent/kek'));
    ensureKeyServiceFiles(settings()); // a new KEK: the operator lost the old one
    await expect(
      resolveSealedSecrets({ settings: settings(), platformKeysFile: null, operatorSecrets: {} })
    ).rejects.toThrow(new RegExp(`bundle ${r.bundleId} was sealed with file key`));
  });
});

describe('agent signing key', () => {
  it('is generated once into the bundle; the Worker gets only its public half', async () => {
    const r = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: null,
      operatorSecrets: {},
    });
    const signing = r.secrets.SAM_KEY_AGENT_SIGNING_KEY ?? '';
    const verify = agentVerifyKey(r.secrets);
    expect(Buffer.from(verify, 'base64')).toHaveLength(32);
    expect(signing).not.toContain(verify);
    const again = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: null,
      operatorSecrets: {},
    });
    expect(again.secrets.SAM_KEY_AGENT_SIGNING_KEY).toBe(signing);
  });
});

describe('copies that leave the box contain no secret', () => {
  const source = () =>
    TOML.parse(
      readFileSync(join(import.meta.dirname, '../../apps/api/wrangler.toml'), 'utf8')
    ) as WranglerToml;

  it('the config celld stores in the fleet bucket: none sealed, all of them without the key service (control)', async () => {
    const r = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: null,
      operatorSecrets: OPERATOR,
    });
    const plan = buildCelldConfig(source(), {
      main: 'celld-main.ts',
      baseDomain: 'sam.example.com',
      vars: {
        SAM_KEY_AGENT_URL: keyAgentUrl(settings()),
        SAM_SECRET_BUNDLE_ID: r.bundleId,
        SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(r.secrets),
      },
    });
    const sealedJson = JSON.stringify(celldDeployConfig(plan.config, r.secrets, true));
    expect(leaks(sealedJson, r.secrets)).toEqual([]);
    expect(sealedJson).toContain(r.bundleId);
    const legacyJson = JSON.stringify(celldDeployConfig(plan.config, r.secrets, false));
    expect(leaks(legacyJson, r.secrets).sort()).toEqual(
      Object.keys(r.secrets)
        .filter((n) => n !== 'SAM_INSTALLATION_ID')
        .sort()
    );
  });

  it('a backup after migration: the bundle is in it, the key file and every plaintext secret are not', async () => {
    const legacy = ensurePlatformKeys(join(state, 'platform-keys.json')).keys;
    writeFileSync(
      join(state, 'secrets.env'),
      Object.entries(OPERATOR)
        .map(([k, v]) => `${k}=${JSON.stringify(v)}`)
        .join('\n'),
      { mode: 0o600 }
    );
    const r = await resolveSealedSecrets({
      settings: settings(),
      platformKeysFile: legacy,
      operatorSecrets: OPERATOR,
    });
    // Retire the plaintext, as the migration ends.
    rmSync(join(state, 'platform-keys.json'));
    rmSync(join(state, 'secrets.env'));
    mkdirSync(join(state, 'key-agent/credentials'), { recursive: true });
    writeFileSync(
      join(state, 'key-agent/credentials/transit-secret-id'),
      'approle-secret-id-value',
      { mode: 0o600 }
    );

    // The fleet bucket as the sealed deploy leaves it: celld's manifest holds the vars only.
    const bucket = join(state, '..', `${state.split('/').pop()}-store`, 'fleet');
    mkdirSync(join(bucket, 'deploy/sam-api/v1'), { recursive: true });
    writeFileSync(
      join(bucket, 'deploy/sam-api/v1/manifest.json'),
      JSON.stringify({ vars: { SAM_SECRET_BUNDLE_ID: r.bundleId } })
    );
    const envFile = join(state, '..', `${state.split('/').pop()}.env`);
    writeFileSync(envFile, 'SAM_KEY_PROVIDER=file\n', { mode: 0o600 });
    const run = (command: string, args: string[]): RunResult => {
      if (command === 'docker' && args[0] === 'run' && args.includes('mirror')) {
        const mount = args[args.indexOf('-v') + 1] ?? '';
        const hostDir = mount.split(':')[0] ?? '';
        for (const file of filesUnder(bucket)) {
          const target = join(hostDir, file.slice(bucket.length + 1));
          mkdirSync(join(target, '..'), { recursive: true });
          writeFileSync(target, readFileSync(file));
        }
      }
      return { status: 0, stdout: '', stderr: '' };
    };
    const ctx: BoxContext = {
      box: {
        CELLD_BUCKET: 's3://fleet',
        S3_ENDPOINT: 'http://127.0.0.1:9000',
        AWS_ACCESS_KEY_ID: 'k',
        AWS_SECRET_ACCESS_KEY: 's',
      },
      envFile,
      stateDir: state,
      composeFiles: ['/unused'],
      run,
      now: () => 0,
      log: () => undefined,
      user: `${uid}:${uid}`,
    };
    expect(OBJECTSTORE_IMAGE).toContain('minio');
    const dest = join(state, '..', `${state.split('/').pop()}-backup`);
    runBackup(ctx, dest);
    const files = filesUnder(dest).map((f) => f.slice(dest.length + 1));
    expect(files).toContain(`state/key-agent/bundles/${r.bundleId}.json`);
    expect(files.some((f) => f.endsWith('manifest.json') && f.includes('deploy/'))).toBe(true);
    expect(
      files.filter((f) => f.includes('key-agent/kek') || f.includes('key-agent/credentials'))
    ).toEqual([]);
    const everything = filesUnder(dest)
      .map((f) => readFileSync(f).toString('latin1'))
      .join('\n');
    expect(
      leaks(everything, {
        ...r.secrets,
        KEK: readFileSync(join(state, 'key-agent/kek'), 'utf8').trim(),
        CRED: 'approle-secret-id-value',
      })
    ).toEqual([]);
    // The bundle copy is intact: with the key service it still opens.
    const copied = parseBundle(
      readFileSync(join(dest, `state/key-agent/bundles/${r.bundleId}.json`), 'utf8')
    );
    expect(
      await openBundle(copied, createFileProvider({ SAM_KEY_FILE: join(state, 'key-agent/kek') }))
    ).toEqual(r.secrets);
  });
});

describe('the celld entry and the egress fence', () => {
  it('wraps the default export and every Durable Object class, and nothing else changes', () => {
    const main = renderRuntimeSecretsMain(['ProjectData', 'TaskRunner', 'ProjectData']);
    expect(main).toContain("export * from './src/index.ts';");
    expect(main).toContain('export default wrapWorker(worker);');
    expect(main.match(/wrapDurableObject\(api\.(\w+)\)/g)).toEqual([
      'wrapDurableObject(api.ProjectData)',
      'wrapDurableObject(api.TaskRunner)',
    ]);
    expect(() => renderRuntimeSecretsMain(['Bad; import x'])).toThrow(/not a valid/);
  });

  it('turns on the celld runtime switches in both key modes, before any request runs', () => {
    // On celld a joiner must resume on its own timer (apps/api/src/lib/shared-flight.ts, R6).
    for (const main of [renderRuntimeSecretsMain(['ProjectData']), renderPlainMain()]) {
      expect(main).toContain(
        "import { resumeSharedFlightJoinsOnOwnTimer } from './src/lib/shared-flight.ts';"
      );
      expect(main.match(/^resumeSharedFlightJoinsOnOwnTimer\(\);$/gm)).toHaveLength(1);
      expect(main).toContain("export * from './src/index.ts';");
    }
    // The plaintext entry is the API's own entry, unwrapped.
    expect(renderPlainMain()).toContain('export default worker;');
    expect(renderPlainMain()).not.toContain('wrapWorker');
  });

  it('covers every Durable Object class the deployed config declares', () => {
    const plan = buildCelldConfig(
      TOML.parse(
        readFileSync(join(import.meta.dirname, '../../apps/api/wrangler.toml'), 'utf8')
      ) as WranglerToml,
      { main: 'celld-main.ts', baseDomain: 'sam.example.com' }
    );
    const main = renderRuntimeSecretsMain(
      plan.config.durable_objects.bindings.map((b) => b.class_name)
    );
    expect(plan.config.durable_objects.bindings.length).toBeGreaterThan(10);
    for (const binding of plan.config.durable_objects.bindings) {
      expect(main).toContain(
        `export const ${binding.class_name} = wrapDurableObject(api.${binding.class_name});`
      );
    }
  });

  it('opens exactly the agent port for celld, only when the key service is on', () => {
    const input = (extra: Record<string, string>) => ({
      box: { CELLD_BUCKET: 's3://fleet', ...extra },
      leaseRange: { start: 20000, end: 29999 },
      resolvConf: 'nameserver 1.1.1.1\n',
      objectStore: [],
    });
    expect(buildFencePlan(input({})).loopbackPorts).not.toContain(7190);
    expect(buildFencePlan(input({ SAM_KEY_PROVIDER: 'file' })).loopbackPorts).toContain(7190);
    expect(
      buildFencePlan(input({ SAM_KEY_PROVIDER: 'file', SAM_KEY_AGENT_PORT: '7200' })).loopbackPorts
    ).toContain(7200);
    expect(() =>
      buildFencePlan(input({ SAM_KEY_PROVIDER: 'file', SAM_KEY_AGENT_PORT: '7001' }))
    ).toThrow();
    expect(() =>
      buildFencePlan(input({ SAM_KEY_PROVIDER: 'file', SAM_KEY_AGENT_PORT: '20010' }))
    ).toThrow(/lease port range/);
  });
});
