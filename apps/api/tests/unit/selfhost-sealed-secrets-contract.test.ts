/**
 * The contract between the two ends of sealed secrets, run end to end: a bundle sealed by the
 * deploy's own path (resolveSealedSecrets, with every platform key), opened and answered by the
 * real key agent (deploy/selfhost/key-agent/server.ts), and read by the Worker's real loader
 * (apps/api/src/selfhost/runtime-secrets.ts) with the vars the deploy renders.
 *
 * The two ends were tested apart, each with a hand-built bundle or answer that left out
 * SAM_INSTALLATION_ID. The real bundle carries it, the agent returned it, and the Worker refuses
 * any answer that names a protected var, so the first sealed deploy on a real box answered 503
 * KEY_AGENT_BAD_RESPONSE on every request.
 */
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyProvider } from '../../../../deploy/selfhost/key-agent/providers.ts';
import { createKeyAgent, SIGNING_KEY_NAME } from '../../../../deploy/selfhost/key-agent/server.ts';
import {
  agentVerifyKey,
  ensureKeyServiceFiles,
  keyServiceSettings,
  resolveSealedSecrets,
} from '../../../../scripts/selfhost/key-service';
import { ensurePlatformKeys, PLATFORM_KEY_NAMES } from '../../../../scripts/selfhost/platform-keys';
import {
  loadRuntimeSecrets,
  resetRuntimeSecretsForTests,
} from '../../src/selfhost/runtime-secrets';

const CELLD_UID = 7101;
const OPERATOR = {
  GITHUB_CLIENT_SECRET: 'gh-client-secret-0123456789abcdef',
  NODE_PROVISIONING_REQUEST_TIMEOUT_MS: '120000',
};

const servers: Array<{ close: () => void }> = [];
let state: string;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'sam-contract-'));
  resetRuntimeSecretsForTests();
});
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
  resetRuntimeSecretsForTests();
});

/** Seals the way `pnpm selfhost:deploy` does on a box migrating from plain files. */
async function sealLikeTheDeploy() {
  const settings = keyServiceSettings(
    { SAM_KEY_PROVIDER: 'file', SAM_KEY_AGENT_UID: String(process.getuid?.() ?? 0) },
    state
  );
  if (!settings) throw new Error('key service off');
  ensureKeyServiceFiles(settings);
  const resolved = await resolveSealedSecrets({
    settings,
    platformKeysFile: ensurePlatformKeys(join(state, 'platform-keys.json')).keys,
    operatorSecrets: OPERATOR,
  });
  const agent = createKeyAgent({
    provider: createKeyProvider(settings.hostEnv),
    bundleDir: settings.bundleDir,
    allowedUids: new Set([CELLD_UID]),
    cacheMs: 1000,
    peerUid: () => CELLD_UID,
    log: () => undefined,
  });
  await new Promise<void>((done) => agent.listen(0, '127.0.0.1', done));
  servers.push(agent);
  const port = (agent.address() as AddressInfo).port;
  // The vars the deploy renders for the Worker (deploy.ts, sealed branch).
  const env = {
    SAM_KEY_AGENT_URL: `http://127.0.0.1:${port}/v1/secrets`,
    SAM_SECRET_BUNDLE_ID: resolved.bundleId,
    SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(resolved.secrets),
    SAM_INSTALLATION_ID: resolved.secrets.SAM_INSTALLATION_ID ?? '',
  };
  return { resolved, env };
}

describe('sealed secrets: deploy seal -> key agent -> Worker loader', () => {
  it('the bundle the deploy seals holds SAM_INSTALLATION_ID (the case that broke)', async () => {
    const { resolved } = await sealLikeTheDeploy();
    for (const name of PLATFORM_KEY_NAMES) expect(resolved.secrets[name]).toBeTruthy();
    expect(resolved.secrets.SAM_INSTALLATION_ID).toMatch(/^[0-9a-f]{32}$/);
  });

  it('the Worker accepts the real agent answer and gets every Worker secret', async () => {
    const { resolved, env } = await sealLikeTheDeploy();
    const secrets = await loadRuntimeSecrets(env);
    // Exactly what deploy.ts treats as the Worker's secrets: the bundle minus the installation
    // id (a var) and the agent's own signing key (never leaves the agent).
    const expected = Object.fromEntries(
      Object.entries(resolved.secrets).filter(
        ([name]) => name !== 'SAM_INSTALLATION_ID' && name !== SIGNING_KEY_NAME
      )
    );
    expect(Object.keys(secrets).sort()).toEqual(Object.keys(expected).sort());
    expect(secrets.ENCRYPTION_KEY).toBe(resolved.secrets.ENCRYPTION_KEY);
    expect(secrets.GITHUB_CLIENT_SECRET).toBe(OPERATOR.GITHUB_CLIENT_SECRET);
    expect(secrets).not.toHaveProperty('SAM_INSTALLATION_ID');
    expect(secrets).not.toHaveProperty(SIGNING_KEY_NAME);
  });

  it('control: the same chain still fails closed against another deployment verify key', async () => {
    const { env } = await sealLikeTheDeploy();
    const other = await (async () => {
      const prev = state;
      state = mkdtempSync(join(tmpdir(), 'sam-contract-other-'));
      const r = await sealLikeTheDeploy();
      state = prev;
      return r.env.SAM_KEY_AGENT_VERIFY_KEY;
    })();
    await expect(loadRuntimeSecrets({ ...env, SAM_KEY_AGENT_VERIFY_KEY: other })).rejects.toThrow(
      /not signed/
    );
  });
});
