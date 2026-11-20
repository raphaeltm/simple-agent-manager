/**
 * The key agent's request handling (deploy/selfhost/key-agent/server.ts) and its peer lookup
 * (peer.ts): who may ask, what the request must look like (a framed protocol over raw TCP, never
 * HTTP: finding F9), and what the cache does when the key service is down or refuses. Real-socket
 * version against celld: live/key-agent-celld.live.test.ts.
 */
import { generateKeyPairSync, type KeyObject, randomBytes, verify } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { type AddressInfo, connect } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, describe, expect, it } from 'vitest';

import { sealSecrets } from '../../deploy/selfhost/key-agent/bundle.ts';
import { openBundleStore } from '../../deploy/selfhost/key-agent/bundle-store.ts';
import { pingKeyAgent } from '../../deploy/selfhost/key-agent/healthcheck.ts';
import { loopbackPeerUid } from '../../deploy/selfhost/key-agent/peer.ts';
import { type KeyProvider, KeyProviderError } from '../../deploy/selfhost/key-agent/provider.ts';
import {
  createFileProvider,
  generateFileKek,
} from '../../deploy/selfhost/key-agent/provider-file.ts';
import {
  assertRunsAsStateOwner,
  createKeyAgent,
  createLegacyAgent,
  KEY_AGENT_PREAMBLE,
  previousProvider,
} from '../../deploy/selfhost/key-agent/server.ts';

const INSTALL = 'e'.repeat(32);
const NONCE = '1'.repeat(32);

const servers: Array<{ close: () => void }> = [];
afterEach(() => {
  for (const s of servers.splice(0)) s.close();
});

/** Every byte the agent sends back on one connection, until it closes it. */
function exchangeRaw(port: number, bytes: Buffer): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const socket = connect({ host: '127.0.0.1', port });
    const chunks: Buffer[] = [];
    socket.setTimeout(3000, () => {
      socket.destroy();
      reject(new Error('the agent neither answered nor closed'));
    });
    socket.on('data', (chunk: Buffer) => chunks.push(chunk));
    socket.on('close', () => resolve(Buffer.concat(chunks)));
    socket.on('error', () => undefined);
    socket.once('connect', () => socket.write(bytes));
  });
}

function frame(body: unknown, preamble: Buffer = KEY_AGENT_PREAMBLE): Buffer {
  const json = Buffer.from(typeof body === 'string' ? body : JSON.stringify(body), 'utf8');
  const length = Buffer.alloc(4);
  length.writeUInt32BE(json.length);
  return Buffer.concat([preamble, length, json]);
}

/** One framed request; the answer envelope, or null when the agent closed without answering. */
async function askFramed(port: number, body: unknown, preamble?: Buffer) {
  const raw = await exchangeRaw(port, frame(body, preamble));
  if (raw.length === 0) return null;
  const size = raw.readUInt32BE(0);
  return JSON.parse(raw.subarray(4, 4 + size).toString('utf8')) as Record<string, unknown>;
}

async function setup(
  options: {
    uid?: number | null;
    wrap?: (p: KeyProvider) => KeyProvider;
    cacheMs?: number;
    staleWaitMs?: number;
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
    bundles: openBundleStore({ dir }),
    allowedUids: new Set([7101]),
    cacheMs: options.cacheMs ?? 1000,
    staleWaitMs: options.staleWaitMs,
    connectionTimeoutMs: 500,
    peerUid: () => (options.uid === undefined ? 7101 : options.uid),
    now: () => now,
    log: (event) => logs.push(event),
  });
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
  servers.push(server);
  const port = (server.address() as AddressInfo).port;
  const request = (init: { bundleId?: string; installationId?: string; nonce?: string } = {}) => ({
    op: 'secrets',
    bundleId: init.bundleId ?? bundle.bundleId,
    nonce: init.nonce ?? NONCE,
    installationId: init.installationId ?? INSTALL,
  });
  const ask = async (init: Parameters<typeof request>[0] = {}) => {
    const envelope = await askFramed(port, request(init));
    if (!envelope) throw new Error('the agent closed without answering');
    return envelope;
  };
  return {
    ask,
    port,
    request,
    bundle,
    logs,
    publicKey: pair.publicKey,
    advance: (ms: number) => (now += ms),
  };
}

describe('who may ask', () => {
  it('serves celld uid a signed answer bound to its nonce, without the signing key', async () => {
    const { ask, bundle, publicKey } = await setup();
    const res = await ask();
    expect(res.status).toBe(200);
    const text = String(res.body);
    expect(JSON.parse(text)).toEqual({
      bundleId: bundle.bundleId,
      nonce: NONCE,
      secrets: { ENCRYPTION_KEY: 'sealed-value-123456' },
    });
    const signature = Buffer.from(String(res.signature), 'base64');
    expect(verify(null, Buffer.from(text), publicKey as KeyObject, signature)).toBe(true);
    // Control: the signature does not verify for another body.
    expect(
      verify(null, Buffer.from(text.replace(NONCE, '2'.repeat(32))), publicKey, signature)
    ).toBe(false);
  });

  // F9 (security review MEDIUM-3 on #2680): the bundle id is in the bucket's deploy vars, so with
  // the old HTTP channel an SSRF from the Worker that could set headers and a JSON body read every
  // secret. Against the HTTP agent this exact request answered 200 with the secrets.
  it('F9: gives nothing to the old HTTP request, even with the real bundle id and headers', async () => {
    const { port, request, bundle, logs } = await setup();
    const body = JSON.stringify({
      bundleId: bundle.bundleId,
      nonce: NONCE,
      installationId: INSTALL,
    });
    const http = Buffer.from(
      [
        'POST /v1/secrets HTTP/1.1',
        `Host: 127.0.0.1:${port}`,
        'content-type: application/json',
        'x-sam-key-agent: 1',
        `content-length: ${Buffer.byteLength(body)}`,
        '',
        body,
      ].join('\r\n')
    );
    const answer = await exchangeRaw(port, http);
    expect(answer).toHaveLength(0);
    expect(answer.toString('latin1')).not.toContain('sealed-value');
    // The same through fetch, as a steered Worker request would be: it gets no response at all.
    await expect(
      fetch(`http://127.0.0.1:${port}/v1/secrets`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-sam-key-agent': '1' },
        body,
      })
    ).rejects.toThrow();
    // An HTTP request with the framed body inside it is refused just the same.
    expect(
      await exchangeRaw(
        port,
        Buffer.concat([Buffer.from('POST / HTTP/1.1\r\n\r\n'), frame(request())])
      )
    ).toHaveLength(0);
    expect(logs.filter((event) => event.event === 'key_agent.bundle_opened')).toHaveLength(0);
    // Liveness: the agent answers the framed request on the same port.
    expect((await askFramed(port, request()))?.status).toBe(200);
  });

  it('refuses a bundle sealed for another installation', async () => {
    const { ask, logs } = await setup();
    const res = await ask({ installationId: 'f'.repeat(32) });
    expect(res.status).toBe(409);
    expect(JSON.stringify(res)).not.toContain('sealed-value');
    expect(logs).toContainEqual(
      expect.objectContaining({ event: 'key_agent.installation_mismatch' })
    );
  });

  it('refuses to serve a bundle that carries no signing key (fail closed)', async () => {
    const { ask } = await setup({ noSigningKey: true });
    expect(await ask()).toEqual({ status: 503, error: 'key_service_invalid' });
  });

  it.each([[0], [1000], [null]])('refuses uid %s', async (uid) => {
    const { ask, logs } = await setup({ uid });
    const res = await ask();
    expect(res).toEqual({ status: 403, error: 'peer_refused' });
    expect(logs).toContainEqual(expect.objectContaining({ event: 'key_agent.peer_refused', uid }));
  });

  it('answers a ping to anyone, with no secret', async () => {
    const { port } = await setup({ uid: 1000 });
    expect(await askFramed(port, { op: 'ping' })).toEqual({ status: 200, ok: true, sealed: true });
    await expect(pingKeyAgent(port)).resolves.toEqual({ sealed: true });
  });

  it.each([
    ['another preamble', { preamble: Buffer.from('\u0000SAMKA1\n') }],
    ['a path traversal id', { body: { bundleId: '../kek' } }],
    ['no nonce', { body: { nonce: '' } }],
    ['an unknown op', { body: { op: 'dump' } }],
    ['a body that is not JSON', { raw: 'not json' }],
  ])('closes the connection for %s, answering nothing', async (_label, init) => {
    const { port, request } = await setup();
    const body = 'raw' in init ? init.raw : { ...request(), ...('body' in init ? init.body : {}) };
    expect(await askFramed(port, body, 'preamble' in init ? init.preamble : undefined)).toBeNull();
  });

  it('closes a connection whose declared length is over the cap, or that never finishes', async () => {
    const { port } = await setup();
    const length = Buffer.alloc(4);
    length.writeUInt32BE(1 << 20);
    expect(await exchangeRaw(port, Buffer.concat([KEY_AGENT_PREAMBLE, length]))).toHaveLength(0);
    // Half a frame: closed after the connection timeout (500 ms here), not held open.
    expect(await exchangeRaw(port, KEY_AGENT_PREAMBLE)).toHaveLength(0);
  });

  it('answers 404 for an unknown bundle', async () => {
    const { ask } = await setup();
    expect(await ask({ bundleId: 'f'.repeat(32) })).toEqual({
      status: 404,
      error: 'bundle_not_found',
    });
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

  // Box round R5 (real Cloud KMS, outbound 443 dropped for the agent only): the agent waited the
  // full key-service timeout (5 s) before serving stale, the Worker gives up after 3 s, and fresh
  // isolates answered 503 KEY_AGENT_UNREACHABLE for the whole outage.
  type Hang = {
    release: ((error?: KeyProviderError) => void) | null;
    calls: number;
    after?: KeyProviderError;
  };
  function hanging(state: Hang) {
    return (real: KeyProvider): KeyProvider => ({
      ...real,
      unwrap: async (w, c) => {
        state.calls += 1;
        if (state.calls !== 2) {
          if (state.calls > 2 && state.after) throw state.after;
          return await real.unwrap(w, c);
        }
        await new Promise<void>((resolve, reject) => {
          state.release = (error) => (error ? reject(error) : resolve());
        });
        return await real.unwrap(w, c);
      },
    });
  }

  async function within<T>(ms: number, promise: Promise<T>): Promise<T | 'timed out'> {
    let timer: ReturnType<typeof setTimeout> | undefined;
    const late = new Promise<'timed out'>((done) => {
      timer = setTimeout(() => done('timed out'), ms);
    });
    try {
      return await Promise.race([promise, late]);
    } finally {
      clearTimeout(timer);
    }
  }

  it('serves the stale copy within the stale wait when the key service hangs', async () => {
    const state: Hang = { release: null, calls: 0 };
    const { ask, advance, logs } = await setup({ wrap: hanging(state), staleWaitMs: 50 });
    expect((await ask()).status).toBe(200);
    advance(1001);
    const res = await within(1000, ask());
    expect(res).not.toBe('timed out');
    expect((res as { status: unknown }).status).toBe(200);
    expect(logs).toContainEqual(
      expect.objectContaining({
        event: 'key_agent.serving_stale',
        reason: expect.stringContaining('slower than 50 ms'),
      })
    );
    // The refresh carried on; a refusal that arrives later still drops the copy.
    state.after = new KeyProviderError('denied', 'HTTP 403');
    state.release?.(state.after);
    await new Promise((done) => setTimeout(done, 10));
    expect((await ask()).status).toBe(503);
  });

  it('control: with no copy in hand a hung key service is waited for, not skipped', async () => {
    const state: Hang = { release: null, calls: 1 }; // the first unwrap already hangs
    const { ask } = await setup({ wrap: hanging(state), staleWaitMs: 50 });
    const pending = ask();
    expect(await within(300, pending)).toBe('timed out');
    state.release?.();
    expect((await pending).status).toBe(200);
  });

  it('drops the copy when the key service refuses (revocation takes effect)', async () => {
    const state: { fail: KeyProviderError | null; calls: number } = { fail: null, calls: 0 };
    const { ask, advance } = await setup({ wrap: flaky(state) });
    await ask();
    state.fail = new KeyProviderError('denied', 'HTTP 403');
    advance(1001);
    expect(await ask()).toEqual({ status: 503, error: 'key_service_denied' });
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
        { ENCRYPTION_KEY: randomBytes(16).toString('hex'), SAM_KEY_AGENT_SIGNING_KEY: signing },
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
      bundles: openBundleStore({ dir: setup.dir }),
      allowedUids: new Set([7101]),
      cacheMs: 0,
      peerUid: () => 7101,
      log: () => undefined,
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    return await askFramed((server.address() as AddressInfo).port, {
      op: 'secrets',
      bundleId,
      nonce: NONCE,
      installationId: INSTALL,
    });
  }

  it("opens the running version's old bundle with the previous provider and the new one with the new", async () => {
    const setup = await twoKeys();
    expect((await ask(true, setup.oldId, setup))?.status).toBe(200);
    expect((await ask(true, setup.newId, setup))?.status).toBe(200);
  });

  it('control: without previous.env the old bundle is refused (the switch window is what serves it)', async () => {
    const setup = await twoKeys();
    expect(await ask(false, setup.oldId, setup)).toEqual({
      status: 503,
      error: 'key_service_config',
    });
    expect((await ask(false, setup.newId, setup))?.status).toBe(200);
  });
});

describe('legacy-plaintext box and start-up', () => {
  it('stays healthy for compose but refuses every secrets request', async () => {
    const server = createLegacyAgent(500);
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    servers.push(server);
    const port = (server.address() as AddressInfo).port;
    await expect(pingKeyAgent(port)).resolves.toEqual({ sealed: false });
    expect(
      await askFramed(port, {
        op: 'secrets',
        bundleId: 'a'.repeat(32),
        nonce: NONCE,
        installationId: INSTALL,
      })
    ).toEqual({ status: 503, error: 'sealed_secrets_off' });
  });

  // F10: the agent no longer starts as root to drop privileges; it refuses root outright.
  it('refuses to run as root, and as a user that cannot read its state', () => {
    if (process.getuid?.() === 0) {
      expect(() => assertRunsAsStateOwner(tmpdir())).toThrow(/must not run as root/);
      return;
    }
    expect(() =>
      assertRunsAsStateOwner(mkdtempSync(join(tmpdir(), 'sam-agent-own-')))
    ).not.toThrow();
    expect(() => assertRunsAsStateOwner(join(tmpdir(), 'sam-agent-missing-dir'))).toThrow(
      /cannot read/
    );
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
