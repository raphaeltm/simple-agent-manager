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
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { openBundle } from '../../deploy/selfhost/key-agent/bundle.ts';
import { createFileProvider } from '../../deploy/selfhost/key-agent/provider-file.ts';
import type { WranglerToml } from '../deploy/types.js';
import { buildCelldConfig } from './celld-config.js';
import { renderCelldMain } from './celld-project.js';
import { refuseRootUnlessPlaintext, resolveBoxKeys } from './deploy-keys.js';
import { buildFencePlan } from './egress-fence.js';
import { agentVerifyKey, celldDeployConfig, resolveSealedSecrets } from './key-seal.js';
import {
  assertKeyAgentUid,
  bundleStoreFor,
  ensureKeyServiceFiles,
  keyAgentAddress,
  keyServiceSettings,
  listBundles,
  renderKeyAgentEnv,
} from './key-service.js';
import { ensurePlatformKeys, PLATFORM_KEY_NAMES } from './platform-keys.js';
import { SELFHOST_DURABLE_OBJECTS } from './selfhost-durable-objects.js';

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

async function settings() {
  const s = keyServiceSettings(box(), state);
  if (!s) throw new Error('key service off');
  await ensureKeyServiceFiles(s);
  return s;
}

/** The deploy's inputs: `init` as on a first `--init`, the mode the other cases need otherwise. */
async function sealInput(
  input: {
    platformKeysFile: Record<string, string> | null;
    operatorSecrets: Record<string, string>;
    unset?: string[];
    log?: (line: string) => void;
  },
  mode: 'init' | 'deploy' | 'dry-run' = 'init'
) {
  return { settings: await settings(), stateDir: state, mode, ...input };
}

const bundles = async () => listBundles(bundleStoreFor(state));

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

  // F10: the agent runs as the state owner from the start; a missing or other uid is refused.
  it('requires SAM_KEY_AGENT_UID to be the deploying (state-owner) uid', () => {
    expect(() => assertKeyAgentUid({ SAM_KEY_PROVIDER: 'file' }, state)).toThrow(
      new RegExp(`SAM_KEY_AGENT_UID=${uid} must be in .env \\(found none\\)`)
    );
    expect(() =>
      assertKeyAgentUid({ SAM_KEY_PROVIDER: 'file', SAM_KEY_AGENT_UID: `${uid}1` }, state)
    ).toThrow(/SAM_KEY_AGENT_UID/);
    expect(() => assertKeyAgentUid(box(), state)).not.toThrow();
  });

  // Codex P2 on #2933: a root --init used to create the key file and bundle as root, then only
  // log the SAM_KEY_AGENT_UID advice, leaving state the root-refusing agent can never use.
  describe('a sealed --init as root', () => {
    afterEach(() => vi.restoreAllMocks());
    const init = () =>
      resolveBoxKeys({
        box: box(),
        stateDir: state,
        secretsPath: join(state, 'secrets.env'),
        mode: 'init',
        unset: [],
        log: () => undefined,
      });

    it('is refused before anything is written', async () => {
      vi.spyOn(process, 'getuid').mockReturnValue(0);
      await expect(init()).rejects.toThrow(/not root/);
      expect(existsSync(join(state, 'key-agent'))).toBe(false);
    });

    // Codex P2 on #2933: deploy.ts calls this before it creates the state dir or records a choice.
    it('refuses root before the deploy writes anything, unless the box stays on plaintext', () => {
      const fresh = join(state, 'not-created-yet');
      expect(() => refuseRootUnlessPlaintext({ box: {}, stateDir: fresh }, 0)).toThrow(/not root/);
      expect(() =>
        refuseRootUnlessPlaintext({ box: { SAM_KEY_PROVIDER: 'file' }, stateDir: fresh }, 0)
      ).toThrow(/not root/);
      expect(existsSync(fresh)).toBe(false);
      // Controls: plaintext stays allowed for root, and the state owner is never refused.
      expect(() =>
        refuseRootUnlessPlaintext({ box: {}, keyProvider: 'legacy-plaintext', stateDir: fresh }, 0)
      ).not.toThrow();
      expect(() =>
        refuseRootUnlessPlaintext(
          { box: { SAM_KEY_PROVIDER: 'legacy-plaintext' }, stateDir: fresh },
          0
        )
      ).not.toThrow();
      expect(() => refuseRootUnlessPlaintext({ box: {}, stateDir: fresh }, 1000)).not.toThrow();
    });

    // Codex P2 on #2933: the --init an upgrade runs on a sealed box used to log the uid advice
    // and carry on, so the stack was recreated with a key agent that cannot read its state.
    it('a missing SAM_KEY_AGENT_UID is advice on a first --init and fatal once the box is sealed', async () => {
      const lines: string[] = [];
      const noUid = () =>
        resolveBoxKeys({
          box: { SAM_KEY_PROVIDER: 'file' },
          stateDir: state,
          secretsPath: join(state, 'secrets.env'),
          mode: 'init',
          unset: [],
          log: (line) => lines.push(line),
        });
      await noUid();
      expect(lines.join('\n')).toContain('SAM_KEY_AGENT_UID');
      expect(await bundles()).toHaveLength(1);
      await expect(noUid()).rejects.toThrow(/SAM_KEY_AGENT_UID/);
      // Control: with the right uid the sealed box's --init passes.
      await expect(init()).resolves.toBeDefined();
    });

    it('control: the state owner seals', async () => {
      await init();
      expect(existsSync(join(state, 'key-agent/kek'))).toBe(true);
    });
  });

  it('writes the agent env with container paths and no secret, and the KEK once (0600)', async () => {
    const s = await settings();
    const kek = readFileSync(join(state, 'key-agent/kek'), 'utf8');
    expect(statSync(join(state, 'key-agent/kek')).mode & 0o077).toBe(0);
    await ensureKeyServiceFiles(s);
    expect(readFileSync(join(state, 'key-agent/kek'), 'utf8')).toBe(kek);
    const env = renderKeyAgentEnv(s);
    expect(env).toContain('SAM_KEY_FILE=/etc/sam/key-agent/kek');
    expect(env).not.toContain(kek.trim());
    expect(keyAgentAddress(s)).toBe('127.0.0.1:7190');
  });
});

describe('resolveSealedSecrets', () => {
  it('first install: generates the platform keys straight into a bundle, no plaintext file', async () => {
    const r = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: OPERATOR,
      })
    );
    expect(r.sealed).toBe(true);
    expect(r.generated).toEqual(expect.arrayContaining(['ENCRYPTION_KEY', 'JWT_PRIVATE_KEY']));
    for (const name of PLATFORM_KEY_NAMES) expect(r.secrets[name]).toBeTruthy();
    expect(existsSync(join(state, 'platform-keys.json'))).toBe(false);
    const [bundle] = await bundles();
    expect(bundle?.bundleId).toBe(r.bundleId);
    expect(
      leaks(readFileSync(join(state, `key-agent/bundles/${r.bundleId}.json`), 'utf8'), r.secrets)
    ).toEqual([]);
  });

  it('migration: seals the existing plain files unchanged, then needs neither file', async () => {
    const legacy = ensurePlatformKeys(state, 'init').keys;
    const first = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: legacy,
        operatorSecrets: OPERATOR,
      })
    );
    expect(first.generated).toEqual(['SAM_KEY_AGENT_SIGNING_KEY']);
    for (const name of PLATFORM_KEY_NAMES) expect(first.secrets[name]).toBe(legacy[name]);
    expect(first.secrets.GITHUB_CLIENT_SECRET).toBe(OPERATOR.GITHUB_CLIENT_SECRET);
    // Same inputs again: the same bundle, no reseal (no key-service call to wrap).
    const again = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: legacy,
        operatorSecrets: OPERATOR,
      })
    );
    expect(again).toMatchObject({ bundleId: first.bundleId, sealed: false });
    // The operator retires the plaintext: the deploy runs from the bundle alone, nothing regenerated.
    rmSync(join(state, 'platform-keys.json'));
    const retired = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: {},
      })
    );
    expect(retired).toMatchObject({ bundleId: first.bundleId, sealed: false, generated: [] });
    expect(retired.secrets).toEqual(first.secrets);
  });

  it('refuses a platform-keys.json that disagrees with the bundle (no silent key rotation)', async () => {
    const first = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: {},
      })
    );
    const stale = { ...first.secrets, ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64') };
    await expect(
      resolveSealedSecrets(await sealInput({ platformKeysFile: stale, operatorSecrets: {} }))
    ).rejects.toThrow(/ENCRYPTION_KEY .* differs from the sealed bundle/);
    // Control: the agreeing file is accepted.
    await expect(
      resolveSealedSecrets(
        await sealInput({
          platformKeysFile: first.secrets,
          operatorSecrets: {},
        })
      )
    ).resolves.toMatchObject({ bundleId: first.bundleId });
  });

  // Codex P2 on #2933: pruning sorted by createdAt alone dropped the bundle just written when the
  // host clock had moved backwards, while the deploy still named it.
  it('keeps the bundle just written even when older bundles carry later timestamps', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      vi.setSystemTime(new Date('2030-01-01T00:00:00Z'));
      for (let i = 0; i < 3; i += 1) {
        await resolveSealedSecrets(
          await sealInput({
            platformKeysFile: null,
            operatorSecrets: { GITHUB_CLIENT_SECRET: `future-secret-${i}-abcdef` },
          })
        );
      }
      vi.setSystemTime(new Date('2026-11-20T00:00:00Z'));
      const r = await resolveSealedSecrets(
        await sealInput({
          platformKeysFile: null,
          operatorSecrets: { GITHUB_CLIENT_SECRET: 'after-clock-rollback-abcdef' },
        })
      );
      expect(r.sealed).toBe(true);
      const kept = (await bundles()).map((b) => b.bundleId);
      expect(kept).toContain(r.bundleId);
      expect(kept).toHaveLength(3);
    } finally {
      vi.useRealTimers();
    }
  });

  it('an operator edit seals a new bundle (new data key); the last three are kept', async () => {
    const ids: string[] = [];
    for (let i = 0; i < 5; i += 1) {
      const r = await resolveSealedSecrets(
        await sealInput({
          platformKeysFile: null,
          operatorSecrets: { GITHUB_CLIENT_SECRET: `rotated-secret-${i}-abcdef` },
        })
      );
      ids.push(r.bundleId);
      await new Promise((done) => setTimeout(done, 5));
    }
    expect(new Set(ids).size).toBe(5);
    const kept = (await bundles()).map((b) => b.bundleId);
    expect(kept).toEqual(ids.slice(2).reverse());
    const newest = (await bundles())[0];
    const wrappedKeys = new Set((await bundles()).map((b) => b.wrappedKey));
    expect(wrappedKeys.size).toBe(3);
    if (!newest) throw new Error('no bundle');
    const opened = await openBundle(
      newest,
      createFileProvider({ SAM_KEY_FILE: join(state, 'key-agent/kek') })
    );
    expect(opened.GITHUB_CLIENT_SECRET).toBe('rotated-secret-4-abcdef');
  });

  it('refuses a bundle sealed for a different key before calling any service', async () => {
    const r = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: {},
      })
    );
    // A lost key file is never replaced while bundles exist: a new one could not open them.
    rmSync(join(state, 'key-agent/kek'));
    await expect(settings()).rejects.toThrow(/key file was lost/);
    // ...but bundles sealed only by another provider do not need it (secrets switch --to file),
    // and an unreadable bundle still counts as needing it.
    const bundles = join(state, 'key-agent/bundles');
    const [name] = readdirSync(bundles);
    const path = join(bundles, name ?? '');
    const sealedWithFile = readFileSync(path, 'utf8');
    writeFileSync(
      path,
      JSON.stringify({ ...(JSON.parse(sealedWithFile) as object), provider: 'gcp-kms' })
    );
    await settings();
    expect(existsSync(join(state, 'key-agent/kek'))).toBe(true);
    rmSync(join(state, 'key-agent/kek'));
    writeFileSync(path, '{not json');
    await expect(settings()).rejects.toThrow(/key file was lost/);
    writeFileSync(path, sealedWithFile);
    writeFileSync(join(state, 'key-agent/kek'), `${Buffer.alloc(32, 9).toString('base64')}\n`, {
      mode: 0o600,
    });
    await expect(
      resolveSealedSecrets(await sealInput({ platformKeysFile: null, operatorSecrets: {} }))
    ).rejects.toThrow(new RegExp(`bundle ${r.bundleId} was sealed with file key`));
  });
});

// Box round R16: deleting a line from secrets.env left the value in the newest sealed bundle
// (bundles merge secrets.env over it), and only moving bundle files by hand removed it.
describe('removing a sealed value (pnpm selfhost:deploy --unset NAME)', () => {
  const newest = async () => {
    const bundle = (await bundles())[0];
    if (!bundle) throw new Error('no bundle');
    return openBundle(bundle, createFileProvider({ SAM_KEY_FILE: join(state, 'key-agent/kek') }));
  };
  // Bundles are ordered by createdAt (ms); two seals in one millisecond would tie, which no real
  // deploy can do. Space them as the other bundle tests do.
  const tick = () => new Promise((done) => setTimeout(done, 5));
  const seal = async (operatorSecrets: Record<string, string>, unset?: string[]) => {
    await tick();
    return resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets,
        unset,
      })
    );
  };

  it('refuses to deploy from an older bundle when the newest cannot be read (Codex P2)', async () => {
    await seal({ ...OPERATOR, PROVIDER_ORPHAN_MIN_AGE_MS: '900000' });
    const removed = await seal({ ...OPERATOR }, ['PROVIDER_ORPHAN_MIN_AGE_MS']);
    // The newest bundle (the one without the retired value) is truncated on disk.
    const path = join(state, 'key-agent', 'bundles', `${removed.bundleId}.json`);
    const intact = readFileSync(path, 'utf8');
    writeFileSync(path, intact.slice(0, 40));
    await expect(seal({ ...OPERATOR })).rejects.toThrow(/cannot be read.*refusing to deploy/s);
    // Removing it does not help: the head names it, and deploying from the older bundle would
    // bring the unset value back (bundle-head.ts).
    rmSync(path);
    await expect(seal({ ...OPERATOR })).rejects.toThrow(
      new RegExp(`names bundle ${removed.bundleId}, which is not there`)
    );
    // Control: once it is restored (from backup), the deploy runs again, without the value.
    writeFileSync(path, intact);
    const after = await seal({ ...OPERATOR });
    expect(after.bundleId).toBe(removed.bundleId);
    expect(after.secrets).not.toHaveProperty('PROVIDER_ORPHAN_MIN_AGE_MS');
  });

  it('refuses when the newest bundle exists but the file system cannot read it (Codex P2)', async () => {
    await seal({ ...OPERATOR, PROVIDER_ORPHAN_MIN_AGE_MS: '900000' });
    const removed = await seal({ ...OPERATOR }, ['PROVIDER_ORPHAN_MIN_AGE_MS']);
    const path = join(state, 'key-agent', 'bundles', `${removed.bundleId}.json`);
    rmSync(path);
    mkdirSync(path); // readFileSync fails with EISDIR, not ENOENT
    await expect(seal({ ...OPERATOR })).rejects.toThrow(/cannot be read.*refusing to deploy/s);
  });

  it('reproduces R16: a deleted secrets.env line survives in the sealed secrets', async () => {
    await seal({ PROVIDER_ORPHAN_MIN_AGE_MS: '900000' });
    const after = await seal({});
    expect(after.secrets.PROVIDER_ORPHAN_MIN_AGE_MS).toBe('900000');
    expect((await newest()).PROVIDER_ORPHAN_MIN_AGE_MS).toBe('900000');
  });

  it('removes it into a new bundle, and keeps every other secret', async () => {
    await seal({ ...OPERATOR, PROVIDER_ORPHAN_MIN_AGE_MS: '900000' });
    const before = await newest();
    const rest: Record<string, string> = { ...OPERATOR };
    const lines: string[] = [];
    await tick();
    const r = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: rest,
        unset: ['PROVIDER_ORPHAN_MIN_AGE_MS'],
        log: (line) => lines.push(line),
      })
    );
    expect(r.sealed).toBe(true);
    const opened = await newest();
    expect((await bundles())[0]?.bundleId).toBe(r.bundleId);
    expect(opened).not.toHaveProperty('PROVIDER_ORPHAN_MIN_AGE_MS');
    const expected = { ...before };
    delete expected.PROVIDER_ORPHAN_MIN_AGE_MS;
    expect(opened).toEqual(expected);
    expect(lines.join('\n')).toContain(
      'removing PROVIDER_ORPHAN_MIN_AGE_MS from the sealed secrets'
    );
    // The next plain deploy keeps it removed.
    expect((await seal(rest)).secrets).not.toHaveProperty('PROVIDER_ORPHAN_MIN_AGE_MS');
  });

  it('refuses while the line is still in secrets.env, and changes nothing', async () => {
    const first = await seal({ PROVIDER_ORPHAN_MIN_AGE_MS: '900000' });
    await expect(
      seal({ PROVIDER_ORPHAN_MIN_AGE_MS: '900000' }, ['PROVIDER_ORPHAN_MIN_AGE_MS'])
    ).rejects.toThrow(/still in secrets\.env.*Delete its line first/);
    expect((await bundles()).map((b) => b.bundleId)).toEqual([first.bundleId]);
  });

  it.each([...PLATFORM_KEY_NAMES, 'SAM_KEY_AGENT_SIGNING_KEY'])(
    'refuses to remove %s, a key SAM generates',
    async (name) => {
      const first = await seal({});
      expect(first.secrets[name]).toBeTruthy();
      await expect(seal({}, [name])).rejects.toThrow(/SAM generates this key/);
      expect((await newest())[name]).toBe(first.secrets[name]);
    }
  );

  it('says when there is nothing to remove, and seals nothing new', async () => {
    const first = await seal({});
    const lines: string[] = [];
    const r = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: {},
        unset: ['NEVER_SET'],
        log: (line) => lines.push(line),
      })
    );
    expect(r.bundleId).toBe(first.bundleId);
    expect(r.sealed).toBe(false);
    expect(lines).toContain('NEVER_SET is not in the sealed secrets; nothing to remove');
  });
});

describe('review fixes', () => {
  // Security review L-2: a plain deploy never writes a key file; only --init does.
  it('creates the file key only when asked (--init), and says to run --init otherwise', async () => {
    const s = keyServiceSettings(box(), state);
    if (!s) throw new Error('key service off');
    await expect(ensureKeyServiceFiles(s, { createKeyFile: false })).rejects.toThrow(
      /run pnpm selfhost:deploy --init first/
    );
    expect(existsSync(join(state, 'key-agent/kek'))).toBe(false);
    await ensureKeyServiceFiles(s, { createKeyFile: true });
    expect(existsSync(join(state, 'key-agent/kek'))).toBe(true);
  });

  // Security review L-4: secrets.env cannot replace the agent's signing key or channel vars.
  it.each(['SAM_KEY_AGENT_SIGNING_KEY', 'SAM_KEY_AGENT_ADDRESS', 'SAM_SECRET_BUNDLE_ID'])(
    'refuses %s in secrets.env',
    async (name) => {
      await expect(
        resolveSealedSecrets(
          await sealInput({ platformKeysFile: null, operatorSecrets: { [name]: 'x' } })
        )
      ).rejects.toThrow(new RegExp(`${name} is set by the sealed deploy`));
      expect(await bundles()).toEqual([]);
    }
  );
});

describe('agent signing key', () => {
  it('is generated once into the bundle; the Worker gets only its public half', async () => {
    const r = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: {},
      })
    );
    const signing = r.secrets.SAM_KEY_AGENT_SIGNING_KEY ?? '';
    const verify = agentVerifyKey(r.secrets);
    expect(Buffer.from(verify, 'base64')).toHaveLength(32);
    expect(signing).not.toContain(verify);
    const again = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: {},
      })
    );
    expect(again.secrets.SAM_KEY_AGENT_SIGNING_KEY).toBe(signing);
  });
});

describe('copies that leave the box contain no secret', () => {
  const source = () =>
    TOML.parse(
      readFileSync(join(import.meta.dirname, '../../apps/api/wrangler.toml'), 'utf8')
    ) as WranglerToml;

  it('the config celld stores in the fleet bucket: none sealed, all of them without the key service (control)', async () => {
    const r = await resolveSealedSecrets(
      await sealInput({
        platformKeysFile: null,
        operatorSecrets: OPERATOR,
      })
    );
    const plan = buildCelldConfig(source(), {
      main: 'celld-main.ts',
      baseDomain: 'sam.example.com',
      vars: {
        SAM_KEY_AGENT_ADDRESS: keyAgentAddress(await settings()),
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
});

describe('the celld entry and the egress fence', () => {
  it('wraps the default export and every Durable Object class, and nothing else changes', () => {
    const main = renderCelldMain(['ProjectData', 'TaskRunner', 'ProjectData']);
    expect(main).toContain("export * from './src/index.ts';");
    expect(main).toContain(
      "import { wrapDurableObject, wrapWorker } from './src/selfhost/runtime-secrets-socket.ts';"
    );
    expect(main).toContain(
      'export default wrapWorker(selfhost.withSelfHostBuild(worker, api.app));'
    );
    expect(main.match(/wrapDurableObject\((?:api|selfhost)\.(\w+)\)/g)).toEqual([
      'wrapDurableObject(selfhost.HostedGitRepo)',
      'wrapDurableObject(api.ProjectData)',
      'wrapDurableObject(api.TaskRunner)',
    ]);
    expect(() => renderCelldMain(['Bad; import x'])).toThrow(/not a valid/);
  });

  it('turns on the celld runtime switch in both key modes; the plain entry is unwrapped', () => {
    for (const main of [renderCelldMain(['ProjectData']), renderCelldMain()]) {
      expect(main).toContain(
        "import { resumeSharedFlightJoinsOnOwnTimer } from './src/lib/shared-flight.ts';"
      );
      expect(main.match(/^resumeSharedFlightJoinsOnOwnTimer\(\);$/gm)).toHaveLength(1);
      expect(main).toContain("export * from './src/index.ts';");
    }
    expect(renderCelldMain()).toContain('export default withSelfHostBuild(worker, app);');
    expect(renderCelldMain()).not.toContain('wrapWorker');
    expect(renderCelldMain()).not.toContain('runtime-secrets');
  });

  it('covers every Durable Object class the deployed config declares', () => {
    const plan = buildCelldConfig(
      TOML.parse(
        readFileSync(join(import.meta.dirname, '../../apps/api/wrangler.toml'), 'utf8')
      ) as WranglerToml,
      { main: 'celld-main.ts', baseDomain: 'sam.example.com' }
    );
    const main = renderCelldMain(plan.config.durable_objects.bindings.map((b) => b.class_name));
    expect(plan.config.durable_objects.bindings.length).toBeGreaterThan(10);
    const selfhostOnly = new Set(SELFHOST_DURABLE_OBJECTS.map((object) => object.className));
    for (const binding of plan.config.durable_objects.bindings) {
      const source = selfhostOnly.has(binding.class_name) ? 'selfhost' : 'api';
      expect(main).toContain(
        `export const ${binding.class_name} = wrapDurableObject(${source}.${binding.class_name});`
      );
    }
    expect(main).toContain(
      'export const HostedGitRepo = wrapDurableObject(selfhost.HostedGitRepo);'
    );
  });

  it('opens exactly the agent port for celld, only on a sealed box', () => {
    const input = (keyAgentPort?: number | null) => ({
      box: { CELLD_BUCKET: 's3://fleet' },
      leaseRange: { start: 20000, end: 29999 },
      resolvConf: 'nameserver 1.1.1.1\n',
      objectStore: [],
      keyAgentPort,
    });
    expect(buildFencePlan(input()).loopbackPorts).not.toContain(7190);
    expect(buildFencePlan(input(null)).loopbackPorts).not.toContain(7190);
    expect(buildFencePlan(input(7190)).loopbackPorts).toContain(7190);
    expect(buildFencePlan(input(7200)).loopbackPorts).toContain(7200);
    expect(() => buildFencePlan(input(7001))).toThrow();
    expect(() => buildFencePlan(input(20010))).toThrow(/lease port range/);
  });
});
