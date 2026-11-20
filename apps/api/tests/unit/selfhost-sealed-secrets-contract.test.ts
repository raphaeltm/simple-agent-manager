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
 *
 * The Worker side reaches the agent through `cloudflare:sockets`, which this suite maps to real
 * `node:net` sockets (tests/mocks/cloudflare-sockets.ts): a real TCP connection to the real agent,
 * the framed protocol both ends implement, and the HTTP refusal that closes finding F9.
 */
import { mkdtempSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { connect } from 'cloudflare:sockets';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createKeyProvider } from '../../../../deploy/selfhost/key-agent/providers.ts';
import {
  createKeyAgent,
  KEY_AGENT_PREAMBLE as AGENT_PREAMBLE,
  SIGNING_KEY_NAME,
} from '../../../../deploy/selfhost/key-agent/server.ts';
import {
  agentVerifyKey,
  ensureKeyServiceFiles,
  keyAgentAddress,
  keyServiceSettings,
  resolveSealedSecrets,
} from '../../../../scripts/selfhost/key-service';
import { ensurePlatformKeys, PLATFORM_KEY_NAMES } from '../../../../scripts/selfhost/platform-keys';
import {
  KEY_AGENT_PREAMBLE,
  type KeyAgentConnect,
  loadRuntimeSecrets,
  resetRuntimeSecretsForTests,
} from '../../src/selfhost/runtime-secrets';

/** The Node-backed `cloudflare:sockets` (vitest alias), as the Worker loader sees it. */
const realSocket = connect as unknown as KeyAgentConnect;

const CELLD_UID = 7101;
const OPERATOR = {
  GITHUB_CLIENT_SECRET: 'gh-client-secret-0123456789abcdef',
  NODE_PROVISIONING_REQUEST_TIMEOUT_MS: '120000',
};

const servers: Array<{ close: () => void }> = [];
let state: string;

beforeEach(() => {
  state = mkdtempSync(join(tmpdir(), 'sam-contract-'));
  resetRuntimeSecretsForTests(realSocket);
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
  await ensureKeyServiceFiles(settings);
  const resolved = await resolveSealedSecrets({
    settings,
    stateDir: state,
    mode: 'init',
    platformKeysFile: ensurePlatformKeys(state, 'init').keys,
    operatorSecrets: OPERATOR,
  });
  const agent = createKeyAgent({
    provider: createKeyProvider(settings.hostEnv),
    bundles: settings.bundles,
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
    SAM_KEY_AGENT_ADDRESS: keyAgentAddress({ port }),
    SAM_SECRET_BUNDLE_ID: resolved.bundleId,
    SAM_KEY_AGENT_VERIFY_KEY: agentVerifyKey(resolved.secrets),
    SAM_INSTALLATION_ID: resolved.secrets.SAM_INSTALLATION_ID ?? '',
  };
  return { resolved, env, port };
}

describe('sealed secrets: deploy seal -> key agent -> Worker loader', () => {
  it('both ends speak the same preamble', () => {
    expect(AGENT_PREAMBLE.toString('utf8')).toBe(KEY_AGENT_PREAMBLE);
    expect(AGENT_PREAMBLE[0]).toBe(0);
  });

  // F9 end to end: the same agent that answers the Worker's socket gives an HTTP client nothing,
  // even one that sends the real bundle id with the headers and body the HTTP agent accepted.
  it('F9: the Worker gets its secrets; an HTTP request with the real bundle id gets nothing', async () => {
    const { resolved, env, port } = await sealLikeTheDeploy();
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sam-key-agent': '1' },
        body: JSON.stringify({
          bundleId: resolved.bundleId,
          nonce: '1'.repeat(32),
          installationId: env.SAM_INSTALLATION_ID,
        }),
      })
    ).rejects.toThrow();
    expect((await loadRuntimeSecrets(env)).ENCRYPTION_KEY).toBe(resolved.secrets.ENCRYPTION_KEY);
  });

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
