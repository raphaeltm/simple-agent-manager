/**
 * The key agent's request handling (deploy/selfhost/key-agent/server.ts) and its peer lookup
 * (peer.ts): who may ask, what the request must look like, and what the cache does when the key
 * service is down or refuses. Real-socket version: live/key-agent-celld.live.test.ts.
 */
import { generateKeyPairSync, type KeyObject, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sealSecrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import { loopbackPeerUid } from '../../deploy/selfhost/key-agent/peer.ts';
import { type KeyProvider, KeyProviderError } from '../../deploy/selfhost/key-agent/provider.ts';
import {
  createFileProvider,
  generateFileKek,
} from '../../deploy/selfhost/key-agent/provider-file.ts';
import {
  createKeyAgent,
  createLegacyAgent,
  dropToOwnerOf,
  previousProvider,
  SIGNATURE_HEADER,
} from '../../deploy/selfhost/key-agent/server.ts';

const INSTALL = 'e'.repeat(32);
const NONCE = '1'.repeat(32);

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function setup(
  options: {
    uid?: number | null;
    wrap?: (p: KeyProvider) => KeyProvider;
    cacheMs?: number;
    noSigningKey?: boolean;
  } = {}
) {
  const pair = generateKeyPairSync('ed25519');
  const signing = pair.privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64');
  const dir = mkdtempSync(join(tmpdir(), 'sam-agent-'));
  writeFileSync(join(dir, 'kek'), generateFileKek(), { mode: 0o600 });
  const real = createFileProvider({ SAM_KEY_FILE: join(dir, 'kek') });
  const sealed: Record<string, string> = { ENCRYPTION_KEY: 'sealed-value-123456' };
  if (!options.noSigningKey) sealed.SAM_KEY_AGENT_SIGNING_KEY = signing;
  const bundle = await sealSecrets(sealed, real, { installationId: INSTALL });
  writeFileSync(join(dir, `${bundle.bundleId}.json`), JSON.stringify(bundle), { mode: 0o600 });
  let now = 0;
  const logs: Array<Record<string, unknown>> = [];
  const server = createKeyAgent({
    provider: options.wrap ? options.wrap(real) : real,
    bundleDir: dir,
    allowedUids: new Set([7101]),
    cacheMs: options.cacheMs ?? 1000,
    peerUid: () => (options.uid === undefined ? 7101 : options.uid),
    now: () => now,
    log: (event) => logs.push(event),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  const ask = (
    init: {
      bundleId?: string;
      installationId?: string;
      nonce?: string;
      headers?: Record<string, string>;
      method?: string;
      path?: string;
    } = {}
  ) =>
    fetch(`${url}${init.path ?? '/v1/secrets'}`, {
      method: init.method ?? 'POST',
      headers: init.headers ?? { 'content-type': 'application/json', 'x-sam-key-agent': '1' },
      body:
        (init.method ?? 'POST') === 'GET'
          ? undefined
          : JSON.stringify({
              bundleId: init.bundleId ?? bundle.bundleId,
              nonce: init.nonce ?? NONCE,
              installationId: init.installationId ?? INSTALL,
            }),
    });
  return { ask, bundle, logs, publicKey: pair.publicKey, advance: (ms: number) => (now += ms) };
}

describe('who may ask', () => {
  it('serves celld uid a signed answer bound to its nonce, without the signing key', async () => {
    const { ask, bundle, publicKey } = await setup();
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    const text = await res.text();
    expect(JSON.parse(text)).toEqual({
      bundleId: bundle.bundleId,
      nonce: NONCE,
      secrets: { ENCRYPTION_KEY: 'sealed-value-123456' },
    });
    const signature = Buffer.from(res.headers.get(SIGNATURE_HEADER) ?? '', 'base64');
    expect(verify(null, Buffer.from(text), publicKey as KeyObject, signature)).toBe(true);
    // Control: the signature does not verify for another body.
    expect(
      verify(null, Buffer.from(text.replace(NONCE, '2'.repeat(32))), publicKey, signature)
    ).toBe(false);
  });

  it('refuses a bundle sealed for another installation', async () => {
    const { ask, logs } = await setup();
    const res = await ask({ installationId: 'f'.repeat(32) });
    expect(res.status).toBe(409);
    expect(await res.text()).not.toContain('sealed-value');
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'key_agent.installation_mismatch' })
    );
  });

  it('refuses to serve a bundle that carries no signing key (fail closed)', async () => {
    const { ask } = await setup({ noSigningKey: true });
    const res = await ask();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'key_service_invalid' });
  });

  it.each([[0], [1000], [null]])('refuses uid %s, before reading the request', async (uid) => {
    const { ask, logs } = await setup({ uid });
    const res = await ask();
    expect(res.status).toBe(403);
    expect(await res.text()).not.toContain('sealed-value');
    expect(logs).toContainEqual(expect.objectContaining({ event: 'key_agent.peer_refused', uid }));
  });

  it.each([
    ['GET', { method: 'GET' }],
    ['no marker header', { headers: { 'content-type': 'application/json' } }],
    [
      'a form body',
      { headers: { 'content-type': 'application/x-www-form-urlencoded', 'x-sam-key-agent': '1' } },
    ],
    ['a path traversal id', { bundleId: '../kek' }],
    ['no nonce', { nonce: '' }],
  ])('refuses %s (the fixed request shape is the SSRF guard)', async (_label, init) => {
    const { ask } = await setup();
    const res = await ask(init);
    expect(res.status).toBe(400);
  });

  it('answers 404 for an unknown bundle and for other paths', async () => {
    const { ask } = await setup();
    expect((await ask({ bundleId: 'f'.repeat(32) })).status).toBe(404);
    expect((await ask({ path: '/v1/secrets/' })).status).toBe(404);
  });
});

describe('cache and key-service failures', () => {
  function flaky(state: { fail: KeyProviderError | null; calls: number }) {
    return (real: KeyProvider): KeyProvider => ({
      ...real,
      unwrap: async (w, c) => {
        state.calls += 1;
        if (state.fail) throw state.fail;
        return await real.unwrap(w, c);
      },
    });
  }

  it('opens once per cache window', async () => {
    const state = { fail: null, calls: 0 };
    const { ask, advance } = await setup({ wrap: flaky(state) });
    await ask();
    await ask();
    expect(state.calls).toBe(1);
    advance(1001);
    await ask();
    expect(state.calls).toBe(2);
  });

  it('serves the stale copy while the key service is unreachable', async () => {
    const state: { fail: KeyProviderError | null; calls: number } = { fail: null, calls: 0 };
    const { ask, advance, logs } = await setup({ wrap: flaky(state) });
    await ask();
    state.fail = new KeyProviderError('unavailable', 'kms down');
    advance(1001);
    expect((await ask()).status).toBe(200);
    expect(logs).toContainEqual(expect.objectContaining({ event: 'key_agent.serving_stale' }));
  });

  it('drops the copy when the key service refuses (revocation takes effect)', async () => {
    const state: { fail: KeyProviderError | null; calls: number } = { fail: null, calls: 0 };
    const { ask, advance } = await setup({ wrap: flaky(state) });
    await ask();
    state.fail = new KeyProviderError('denied', 'HTTP 403');
    advance(1001);
    const res = await ask();
    expect(res.status).toBe(503);
    expect(await res.json()).toEqual({ error: 'key_service_denied' });
    state.fail = new KeyProviderError('unavailable', 'kms down');
    expect((await ask()).status).toBe(503); // nothing stale left to serve
  });
});

describe('during a provider switch (previous.env)', () => {
  async function twoKeys() {
    const dir = mkdtempSync(join(tmpdir(), 'sam-agent-switch-'));
    writeFileSync(join(dir, 'old-kek'), generateFileKek(), { mode: 0o600 });
    writeFileSync(join(dir, 'new-kek'), generateFileKek(), { mode: 0o600 });
    writeFileSync(
      join(dir, 'previous.env'),
      `SAM_KEY_PROVIDER=file\nSAM_KEY_FILE=${join(dir, 'old-kek')}\n`,
      {
        mode: 0o600,
      }
    );
    const signing = generateKeyPairSync('ed25519')
      .privateKey.export({ type: 'pkcs8', format: 'der' })
      .toString('base64');
    const oldKey = createFileProvider({ SAM_KEY_FILE: join(dir, 'old-kek') });
    const newKey = createFileProvider({ SAM_KEY_FILE: join(dir, 'new-kek') });
    const ids: string[] = [];
    for (const provider of [oldKey, newKey]) {
      const bundle = await sealSecrets(
        { ENCRYPTION_KEY: 'v-0123456789', SAM_KEY_AGENT_SIGNING_KEY: signing },
        provider,
        {
          installationId: INSTALL,
        }
      );
      writeFileSync(join(dir, `${bundle.bundleId}.json`), JSON.stringify(bundle), { mode: 0o600 });
      ids.push(bundle.bundleId);
    }
    return { dir, newKey, oldId: ids[0] ?? '', newId: ids[1] ?? '' };
  }

  async function ask(
    previous: boolean,
    bundleId: string,
    setup: Awaited<ReturnType<typeof twoKeys>>
  ) {
    const server = createKeyAgent({
      provider: setup.newKey,
      previousProvider: previous ? previousProvider(setup.dir) : undefined,
      bundleDir: setup.dir,
      allowedUids: new Set([7101]),
      cacheMs: 0,
      peerUid: () => 7101,
      log: () => undefined,
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    return await fetch(`http://127.0.0.1:${(server.address() as AddressInfo).port}/v1/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sam-key-agent': '1' },
      body: JSON.stringify({ bundleId, nonce: NONCE, installationId: INSTALL }),
    });
  }

  it("opens the running version's old bundle with the previous provider and the new one with the new", async () => {
    const setup = await twoKeys();
    expect((await ask(true, setup.oldId, setup)).status).toBe(200);
    expect((await ask(true, setup.newId, setup)).status).toBe(200);
  });

  it('control: without previous.env the old bundle is refused (the switch window is what serves it)', async () => {
    const setup = await twoKeys();
    const refused = await ask(false, setup.oldId, setup);
    expect(refused.status).toBe(503);
    expect(await refused.json()).toEqual({ error: 'key_service_config' });
    expect((await ask(false, setup.newId, setup)).status).toBe(200);
  });
});

describe('legacy-plaintext box and start-up', () => {
  it('stays healthy for compose but refuses every secrets request', async () => {
    const server = createLegacyAgent();
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    const health = await fetch(`${url}/healthz`);
    expect(health.status).toBe(200);
    expect(await health.json()).toEqual({ ok: true, sealed: false });
    const asked = await fetch(`${url}/v1/secrets`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-sam-key-agent': '1' },
      body: JSON.stringify({ bundleId: 'a'.repeat(32), nonce: NONCE, installationId: INSTALL }),
    });
    expect(asked.status).toBe(503);
    expect(await asked.json()).toEqual({ error: 'sealed_secrets_off' });
  });

  it('does not change uid unless it runs as root', () => {
    if (process.getuid?.() === 0) return; // the root path is exercised by the compose live test
    expect(dropToOwnerOf(tmpdir())).toBeNull();
  });
});

describe('loopbackPeerUid', () => {
  // 127.0.0.1:43210 -> 127.0.0.1:7190, owned by 7101; a TIME_WAIT twin owned by 0.
  const table = [
    '  sl  local_address rem_address   st tx_queue rx_queue tr tm->when retrnsmt   uid  timeout inode',
    '   0: 0100007F:1C16 00000000:0000 0A 00000000:00000000 00:00000000 00000000  7104        0 1 1',
    '   1: 0100007F:A8CA 0100007F:1C16 06 00000000:00000000 03:00000000 00000000     0        0 0 3',
    '   2: 0100007F:A8CA 0100007F:1C16 01 00000000:00000000 00:00000000 00000000  7101        0 2 1',
  ].join('\n');
  const conn = {
    clientAddress: '127.0.0.1',
    clientPort: 43210,
    serverAddress: '127.0.0.1',
    serverPort: 7190,
  };

  it('finds the ESTABLISHED client socket owner, ignoring TIME_WAIT', () => {
    expect(loopbackPeerUid(conn, 'x', () => table)).toBe(7101);
    expect(loopbackPeerUid({ ...conn, clientAddress: '::ffff:127.0.0.1' }, 'x', () => table)).toBe(
      7101
    );
  });

  it('returns null (refuse) when unknown, ambiguous, or unreadable', () => {
    expect(loopbackPeerUid({ ...conn, clientPort: 1 }, 'x', () => table)).toBeNull();
    expect(
      loopbackPeerUid(
        conn,
        'x',
        () => `${table}\n   3: 0100007F:A8CA 0100007F:1C16 01 0:0 0:0 0 1000 0 9 1`
      )
    ).toBeNull();
    expect(
      loopbackPeerUid(conn, 'x', () => {
        throw new Error('EACCES');
      })
    ).toBeNull();
    expect(loopbackPeerUid({ ...conn, clientAddress: '::1' }, 'x', () => table)).toBeNull();
  });
});
