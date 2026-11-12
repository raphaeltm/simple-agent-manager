/**
 * The key agent's request handling (deploy/selfhost/key-agent/server.ts) and its peer lookup
 * (peer.ts): who may ask, what the request must look like, and what the cache does when the key
 * service is down or refuses. Real-socket version: live/key-agent-celld.live.test.ts.
 */
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
import { createKeyAgent } from '../../deploy/selfhost/key-agent/server.ts';

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

async function setup(
  options: { uid?: number | null; wrap?: (p: KeyProvider) => KeyProvider; cacheMs?: number } = {}
) {
  const dir = mkdtempSync(join(tmpdir(), 'sam-agent-'));
  writeFileSync(join(dir, 'kek'), generateFileKek(), { mode: 0o600 });
  const real = createFileProvider({ SAM_KEY_FILE: join(dir, 'kek') });
  const bundle = await sealSecrets({ ENCRYPTION_KEY: 'sealed-value-123456' }, real, {
    installationId: 'e'.repeat(32),
  });
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
          : JSON.stringify({ bundleId: init.bundleId ?? bundle.bundleId }),
    });
  return { ask, bundle, logs, advance: (ms: number) => (now += ms) };
}

describe('who may ask', () => {
  it('serves celld uid', async () => {
    const { ask, bundle } = await setup();
    const res = await ask();
    expect(res.status).toBe(200);
    expect(res.headers.get('cache-control')).toBe('no-store');
    expect(await res.json()).toEqual({
      bundleId: bundle.bundleId,
      secrets: { ENCRYPTION_KEY: 'sealed-value-123456' },
    });
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
