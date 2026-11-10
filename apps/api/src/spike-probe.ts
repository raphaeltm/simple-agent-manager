// SPIKE ONLY (self-host Track A, branch sam/self-host-spike-track-anyb55). Not for main.
// Exercises the runtime features SAM depends on, through SAM's own helpers where they exist,
// so a celld run reports pass/fail per feature instead of inferring it from page loads.
// Mounted at /__spike/* only when env.SPIKE_PROBE === 'true'.
import { DurableObject } from 'cloudflare:workers';
import { Hono } from 'hono';
import { createHash } from 'node:crypto';

import type { Env } from './env';
import { scheduled } from './scheduled/handler';
import { createRequestScopedD1 } from './lib/d1-session';
import { createVapidAuthorization } from './lib/web-push';
import { sha256Hex } from './project-data-archive/hashing';
import { signDeployPayload } from './services/deploy-signing';
import { decrypt, encrypt } from './services/encryption';
import {
  signCallbackToken,
  signTerminalToken,
  verifyCallbackToken,
  verifyTerminalToken,
} from './services/jwt';

type Result = { name: string; ok: boolean; detail?: unknown; error?: string };

async function check(results: Result[], name: string, fn: () => Promise<unknown>): Promise<void> {
  try {
    const detail = await fn();
    results.push({ name, ok: detail !== false, detail });
  } catch (err) {
    const e = err as Error;
    results.push({ name, ok: false, error: `${e?.name}: ${e?.message}` });
  }
}

function assert(cond: unknown, msg: string): void {
  if (!cond) throw new Error(`assertion failed: ${msg}`);
}

type ProbeEnv = Env & { SPIKE_PROBE?: string; SPIKE_PROBE_DO?: DurableObjectNamespace<SpikeProbeDO> };

export const spikeProbeRoutes = new Hono<{ Bindings: ProbeEnv }>();

spikeProbeRoutes.use('*', async (c, next) => {
  if (c.env.SPIKE_PROBE !== 'true') return c.json({ error: 'disabled' }, 404);
  return next();
});

spikeProbeRoutes.get('/runtime', async (c) => {
  const env = c.env;
  const r: Result[] = [];
  const db = env.DATABASE;

  // ── D1 ──────────────────────────────────────────────────────────────
  await check(r, 'd1.withSession.present', async () => ({
    typeofWithSession: typeof (db as Partial<D1Database>).withSession,
  }));
  await check(r, 'd1.requestScoped.query', async () => {
    const scoped = createRequestScopedD1(db, 'first-primary');
    const row = await scoped.prepare('SELECT 1 AS one').first<{ one: number }>();
    assert(row?.one === 1, 'scoped query returned 1');
    return { usedSessionFacade: scoped !== db };
  });
  await check(r, 'd1.withSession.bookmark', async () => {
    const s = db.withSession('first-primary');
    await s.prepare('SELECT 1').first();
    return { bookmark: s.getBookmark?.() ?? null };
  });
  await check(r, 'd1.setup', async () => {
    await db.batch([
      db.prepare('DROP TABLE IF EXISTS spike_probe'),
      db.prepare('DROP TABLE IF EXISTS spike_probe_log'),
      db.prepare('CREATE TABLE spike_probe (id TEXT PRIMARY KEY, v INTEGER NOT NULL)'),
      db.prepare('CREATE TABLE spike_probe_log (id INTEGER PRIMARY KEY AUTOINCREMENT, note TEXT)'),
    ]);
    return true;
  });
  await check(r, 'd1.batch.atomic_rollback', async () => {
    let threw = false;
    try {
      await db.batch([
        db.prepare('INSERT INTO spike_probe (id, v) VALUES (?, ?)').bind('a', 1),
        db.prepare('INSERT INTO spike_probe (id, v) VALUES (?, ?)').bind('a', 2), // PK violation
      ]);
    } catch {
      threw = true;
    }
    const n = await db.prepare('SELECT count(*) AS n FROM spike_probe').first<{ n: number }>();
    assert(threw, 'batch threw on constraint violation');
    assert(n?.n === 0, `first insert rolled back (rows=${n?.n})`);
    return { threw, rowsAfter: n?.n };
  });
  await check(r, 'd1.meta.changes.cas', async () => {
    const ins = await db.prepare('INSERT INTO spike_probe (id, v) VALUES (?, ?)').bind('b', 1).run();
    const hit = await db.prepare('UPDATE spike_probe SET v = 2 WHERE id = ? AND v = 1').bind('b').run();
    const miss = await db.prepare('UPDATE spike_probe SET v = 3 WHERE id = ? AND v = 1').bind('b').run();
    assert(hit.meta.changes === 1, `hit changes=${hit.meta.changes}`);
    assert(miss.meta.changes === 0, `miss changes=${miss.meta.changes}`);
    return {
      insertMeta: { changes: ins.meta.changes, last_row_id: ins.meta.last_row_id, rows_written: ins.meta.rows_written },
      hit: { changes: hit.meta.changes, rows_written: hit.meta.rows_written, changed_db: hit.meta.changed_db },
      miss: { changes: miss.meta.changes },
    };
  });
  await check(r, 'd1.meta.changes.with_writing_trigger', async () => {
    await db.prepare(
      "CREATE TRIGGER IF NOT EXISTS spike_probe_au AFTER UPDATE ON spike_probe BEGIN INSERT INTO spike_probe_log(note) VALUES ('u'); END"
    ).run();
    const res = await db.prepare('UPDATE spike_probe SET v = 9 WHERE id = ?').bind('b').run();
    await db.prepare('DROP TRIGGER spike_probe_au').run();
    // Cloudflare D1 reports 2 here (trigger writes counted). Report, don't assert.
    return { changes: res.meta.changes, rows_written: res.meta.rows_written };
  });
  await check(r, 'd1.batch.results_and_bind_limit', async () => {
    const binds = Array.from({ length: 100 }, (_, i) => i);
    const ok = await db.prepare(`SELECT ${binds.map(() => '?').join(',')}`).bind(...binds).all();
    let over: string | null = null;
    try {
      const b101 = Array.from({ length: 101 }, (_, i) => i);
      await db.prepare(`SELECT ${b101.map(() => '?').join(',')}`).bind(...b101).all();
    } catch (e) {
      over = (e as Error).message;
    }
    return { hundredOk: ok.success, overLimitError: over };
  });
  await check(r, 'd1.exec_and_dump', async () => {
    const ex = await db.exec('SELECT 1; SELECT 2;');
    return { execCount: ex.count };
  });

  // ── WebCrypto / jose / node:crypto through SAM helpers ─────────────
  await check(r, 'crypto.jwt.callback_roundtrip', async () => {
    const t = await signCallbackToken('ws-probe', env, { callbackGeneration: null });
    const p = await verifyCallbackToken(t, env, { expectedScope: 'workspace' });
    assert(p.workspace === 'ws-probe', 'workspace claim');
    return { scope: p.scope };
  });
  await check(r, 'crypto.jwt.terminal_roundtrip', async () => {
    const { token } = await signTerminalToken('spike-user-1', 'ws-probe', env);
    const p = await verifyTerminalToken(token, env);
    return { workspace: p.workspace };
  });
  await check(r, 'crypto.jwt.tampered_rejected', async () => {
    const t = await signCallbackToken('ws-probe', env, { callbackGeneration: null });
    const bad = t.slice(0, -4) + (t.endsWith('AAAA') ? 'BBBB' : 'AAAA');
    try {
      await verifyCallbackToken(bad, env);
    } catch (e) {
      return { rejectedWith: (e as Error).message };
    }
    throw new Error('tampered token accepted');
  });
  await check(r, 'crypto.aes_gcm_roundtrip', async () => {
    const { ciphertext, iv } = await encrypt('secret-value', env.ENCRYPTION_KEY);
    const back = await decrypt(ciphertext, iv, env.ENCRYPTION_KEY);
    assert(back === 'secret-value', 'decrypt');
    return true;
  });
  await check(r, 'crypto.ed25519_sign_verify', async () => {
    const payload = { releaseId: 'r1', nodeId: 'n1', composeYaml: 'x', env: {} } as never;
    const sigB64 = await signDeployPayload(payload, env);
    const pub = Uint8Array.from(atob(env.DEPLOY_SIGNING_PUBLIC_KEY ?? ''), (ch) => ch.charCodeAt(0));
    const key = await crypto.subtle.importKey('raw', pub, { name: 'Ed25519' }, false, ['verify']);
    const sig = Uint8Array.from(atob(sigB64), (ch) => ch.charCodeAt(0));
    // Verify a direct signature too (the SAM helper signs canonical bytes we don't rebuild here).
    const priv = await crypto.subtle.generateKey({ name: 'Ed25519' }, true, ['sign', 'verify']);
    const msg = new TextEncoder().encode('m');
    const s2 = await crypto.subtle.sign('Ed25519', (priv as CryptoKeyPair).privateKey, msg);
    const ok2 = await crypto.subtle.verify('Ed25519', (priv as CryptoKeyPair).publicKey, s2, msg);
    return { samSigBytes: sig.length, importedSamPublicKey: !!key, generatedKeyVerify: ok2 };
  });
  await check(r, 'crypto.hmac_sha256', async () => {
    const key = await crypto.subtle.importKey(
      'raw',
      new TextEncoder().encode('k'),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['sign', 'verify']
    );
    const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode('m'));
    return { ok: await crypto.subtle.verify('HMAC', key, sig, new TextEncoder().encode('m')) };
  });
  await check(r, 'crypto.vapid_es256', async () => {
    const auth = await createVapidAuthorization('https://fcm.googleapis.com/fcm/send/abc', {
      publicKey: env.VAPID_PUBLIC_KEY ?? '',
      privateKey: env.VAPID_PRIVATE_KEY ?? '',
      subject: env.VAPID_SUBJECT ?? '',
    });
    return { prefix: auth.slice(0, 12) };
  });
  await check(r, 'crypto.rsa_oaep_and_pss', async () => {
    const out: Record<string, string> = {};
    for (const alg of [
      { name: 'RSA-OAEP', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      { name: 'RSA-PSS', modulusLength: 2048, publicExponent: new Uint8Array([1, 0, 1]), hash: 'SHA-256' },
      { name: 'ECDH', namedCurve: 'P-256' },
    ]) {
      try {
        await crypto.subtle.generateKey(alg as never, false, (alg.name === 'RSA-OAEP' ? ['encrypt', 'decrypt'] : alg.name === 'ECDH' ? ['deriveBits'] : ['sign', 'verify']) as never);
        out[alg.name] = 'ok';
      } catch (e) {
        out[alg.name] = (e as Error).message;
      }
    }
    return out;
  });
  await check(r, 'node_crypto.createHash', async () => {
    const h = createHash('sha256').update('abc').digest('hex');
    assert(h === 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad', 'sha256(abc)');
    return { samSha256Hex: await sha256Hex('abc') };
  });
  await check(r, 'node.misc', async () => {
    const out: Record<string, string> = {};
    const tryIt = async (name: string, f: () => Promise<unknown> | unknown) => {
      try {
        const v = await f();
        out[name] = typeof v === 'string' ? v.slice(0, 40) : 'ok';
      } catch (e) {
        out[name] = 'ERR ' + (e as Error).message.slice(0, 120);
      }
    };
    await tryIt('AsyncLocalStorage', async () => {
      const { AsyncLocalStorage } = await import('node:async_hooks');
      const als = new AsyncLocalStorage<number>();
      return als.run(7, async () => {
        await Promise.resolve();
        return String(als.getStore());
      });
    });
    await tryIt('Buffer', () => Buffer.from('hi').toString('base64'));
    await tryIt('crypto.randomUUID', () => crypto.randomUUID());
    await tryIt('node:crypto.randomBytes', async () => (await import('node:crypto')).randomBytes(4).toString('hex'));
    await tryIt('node:crypto.createHmac', async () => (await import('node:crypto')).createHmac('sha256', 'k').update('m').digest('hex'));
    await tryIt('node:crypto.createCipheriv', async () => {
      const nc = await import('node:crypto');
      return nc.createCipheriv('aes-256-gcm', nc.randomBytes(32), nc.randomBytes(12)).update('x', 'utf8', 'hex');
    });
    await tryIt('node:zlib.gzipSync', async () => (await import('node:zlib')).gzipSync(Buffer.from('x')).length.toString());
    await tryIt('CompressionStream', async () => {
      const cs = new Blob(['hello']).stream().pipeThrough(new CompressionStream('gzip'));
      return String((await new Response(cs).arrayBuffer()).byteLength);
    });
    await tryIt('caches', () => typeof (globalThis as { caches?: unknown }).caches);
    await tryIt('navigator.userAgent', () => String((globalThis as { navigator?: { userAgent?: string } }).navigator?.userAgent));
    await tryIt('scheduler.wait', () => typeof (globalThis as { scheduler?: { wait?: unknown } }).scheduler?.wait);
    await tryIt('HTMLRewriter', () => typeof (globalThis as { HTMLRewriter?: unknown }).HTMLRewriter);
    return out;
  });

  // ── KV ──────────────────────────────────────────────────────────────
  await check(r, 'kv.put_get_list_delete', async () => {
    await env.KV.put('spike:k1', 'v1', { expirationTtl: 120, metadata: { m: 1 } });
    const v = await env.KV.get('spike:k1');
    const wm = await env.KV.getWithMetadata<{ m: number }>('spike:k1');
    const json = await env.KV.put('spike:k2', JSON.stringify({ a: 1 })).then(() => env.KV.get('spike:k2', 'json'));
    const list = await env.KV.list({ prefix: 'spike:' });
    await env.KV.delete('spike:k1');
    const gone = await env.KV.get('spike:k1');
    assert(v === 'v1' && gone === null, 'get/delete');
    return { metadata: wm.metadata, json, listed: list.keys.map((k) => k.name), listComplete: list.list_complete };
  });

  // ── R2 ──────────────────────────────────────────────────────────────
  await check(r, 'r2.put_get_head_list_range_delete', async () => {
    const body = 'x'.repeat(1024);
    const put = await env.R2.put('spike/obj.txt', body, {
      httpMetadata: { contentType: 'text/plain' },
      customMetadata: { a: 'b' },
    });
    const head = await env.R2.head('spike/obj.txt');
    const got = await env.R2.get('spike/obj.txt');
    const text = await got?.text();
    const range = await env.R2.get('spike/obj.txt', { range: { offset: 10, length: 5 } });
    const rangeText = await range?.text();
    const list = await env.R2.list({ prefix: 'spike/' });
    const cond = await env.R2.get('spike/obj.txt', { onlyIf: { etagDoesNotMatch: put?.etag ?? '' } });
    await env.R2.delete('spike/obj.txt');
    const after = await env.R2.head('spike/obj.txt');
    assert(text === body, 'body roundtrip');
    return {
      etag: put?.etag,
      contentType: head?.httpMetadata?.contentType,
      customMetadata: head?.customMetadata,
      rangeLen: rangeText?.length,
      listed: list.objects.map((o) => o.key),
      conditionalGetBody: cond && 'body' in cond ? 'body' : 'no-body',
      deleted: after === null,
    };
  });
  await check(r, 'r2.multipart', async () => {
    const mp = await env.R2.createMultipartUpload('spike/mp.bin');
    const part = 'y'.repeat(5 * 1024 * 1024);
    const p1 = await mp.uploadPart(1, part);
    const p2 = await mp.uploadPart(2, 'tail');
    const obj = await mp.complete([p1, p2]);
    await env.R2.delete('spike/mp.bin');
    return { size: obj.size };
  });

  // ── Durable Object probe ───────────────────────────────────────────
  await check(r, 'do.binding_present', async () => ({ present: !!env.SPIKE_PROBE_DO }));
  if (env.SPIKE_PROBE_DO) {
    const stub = env.SPIKE_PROBE_DO.get(env.SPIKE_PROBE_DO.idFromName('probe'));
    await check(r, 'do.rpc.storage_features', async () => stub.storageFeatures());
    await check(r, 'do.rpc.error_shape', async () => {
      try {
        await stub.throwTyped();
      } catch (e) {
        const err = e as Error & { code?: string; status?: number };
        return { name: err.name, message: err.message, code: err.code ?? null, status: err.status ?? null, isInstanceOfError: e instanceof Error };
      }
      throw new Error('RPC did not throw');
    });
    await check(r, 'do.alarm.arm', async () => stub.armAlarm(1500));
  }

  return c.json({ ok: r.every((x) => x.ok), results: r });
});

// Invoke SAM's real scheduled() handler with an arbitrary cron string (hourly / daily can't be
// waited for in a time-boxed spike). celld's own trigger is verified separately by waiting.
spikeProbeRoutes.post('/scheduled', async (c) => {
  const cron = c.req.query('cron') ?? '*/5 * * * *';
  const t0 = Date.now();
  const pending: Promise<unknown>[] = [];
  const ctx = {
    waitUntil: (p: Promise<unknown>) => pending.push(p),
    passThroughOnException: () => undefined,
    props: {},
  } as unknown as ExecutionContext;
  let error: string | null = null;
  try {
    await scheduled({ cron, scheduledTime: Date.now(), noRetry: () => undefined } as ScheduledController, c.env, ctx);
    await Promise.allSettled(pending);
  } catch (e) {
    error = `${(e as Error).name}: ${(e as Error).message}`;
  }
  return c.json({ cron, ms: Date.now() - t0, waitUntil: pending.length, error });
});

spikeProbeRoutes.get('/alarm-status', async (c) => {
  if (!c.env.SPIKE_PROBE_DO) return c.json({ error: 'no SPIKE_PROBE_DO' }, 500);
  const stub = c.env.SPIKE_PROBE_DO.get(c.env.SPIKE_PROBE_DO.idFromName('probe'));
  return c.json(await stub.alarmStatus());
});

spikeProbeRoutes.get('/ws', async (c) => {
  if (!c.env.SPIKE_PROBE_DO) return c.json({ error: 'no SPIKE_PROBE_DO' }, 500);
  const stub = c.env.SPIKE_PROBE_DO.get(c.env.SPIKE_PROBE_DO.idFromName('probe'));
  return stub.fetch(c.req.raw);
});

class TypedError extends Error {
  code = 'SPIKE_CODE';
  status = 409;
  constructor() {
    super('typed failure');
    this.name = 'TypedError';
  }
}

export class SpikeProbeDO extends DurableObject<ProbeEnv> {
  private readonly bootOrder: string[] = [];
  private readonly instanceStartedAt = Date.now();

  constructor(ctx: DurableObjectState, env: ProbeEnv) {
    super(ctx, env);
    void ctx.blockConcurrencyWhile(async () => {
      await new Promise((resolve) => setTimeout(resolve, 20));
      this.ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS kv (k TEXT PRIMARY KEY, v TEXT NOT NULL)'
      );
      this.bootOrder.push('blockConcurrencyWhile-done');
    });
  }

  storageFeatures(): Record<string, unknown> {
    const sql = this.ctx.storage.sql;
    this.bootOrder.push('rpc');
    sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('a', '1')");
    const cursor = sql.exec('SELECT k, v FROM kv');
    const rows = cursor.toArray();
    let txRolledBack = false;
    try {
      this.ctx.storage.transactionSync(() => {
        sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('t', 'x')");
        throw new Error('rollback');
      });
    } catch {
      txRolledBack = sql.exec("SELECT count(*) AS n FROM kv WHERE k = 't'").one().n === 0;
    }
    const committed = this.ctx.storage.transactionSync(() => {
      sql.exec("INSERT OR REPLACE INTO kv (k, v) VALUES ('c', 'y')");
      return sql.exec("SELECT v FROM kv WHERE k = 'c'").one().v;
    });
    let kvApi: unknown = null;
    try {
      // SQLite-backed DOs also expose the synchronous KV API.
      this.ctx.storage.kv.put('kk', { n: 1 });
      kvApi = this.ctx.storage.kv.get('kk');
    } catch (e) {
      kvApi = 'ERR ' + (e as Error).message;
    }
    return {
      bootOrder: [...this.bootOrder],
      rows,
      rowsRead: cursor.rowsRead,
      rowsWritten: cursor.rowsWritten,
      columnNames: cursor.columnNames,
      databaseSize: sql.databaseSize,
      txRolledBack,
      committed,
      kvApi,
      id: this.ctx.id.toString(),
      idName: (this.ctx.id as { name?: string }).name ?? null,
    };
  }

  throwTyped(): never {
    throw new TypedError();
  }

  async armAlarm(ms: number): Promise<Record<string, unknown>> {
    const at = Date.now() + ms;
    await this.ctx.storage.put('alarmArmedAt', Date.now());
    await this.ctx.storage.put('alarmFiredAt', null);
    await this.ctx.storage.setAlarm(at);
    return { scheduledFor: at, getAlarm: await this.ctx.storage.getAlarm() };
  }

  async alarm(info?: { retryCount?: number; isRetry?: boolean }): Promise<void> {
    await this.ctx.storage.put('alarmFiredAt', Date.now());
    await this.ctx.storage.put('alarmInfo', info ?? null);
    for (const ws of this.ctx.getWebSockets('probe-tag')) {
      ws.send(JSON.stringify({ type: 'alarm-fired' }));
    }
  }

  async alarmStatus(): Promise<Record<string, unknown>> {
    return {
      armedAt: await this.ctx.storage.get('alarmArmedAt'),
      firedAt: await this.ctx.storage.get('alarmFiredAt'),
      info: await this.ctx.storage.get('alarmInfo'),
      pendingAlarm: await this.ctx.storage.getAlarm(),
      sockets: this.ctx.getWebSockets().length,
      taggedSockets: this.ctx.getWebSockets('probe-tag').length,
    };
  }

  async fetch(request: Request): Promise<Response> {
    if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') {
      return new Response('expected websocket', { status: 400 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair) as [WebSocket, WebSocket];
    this.ctx.acceptWebSocket(server, ['probe-tag', `t-${Date.now()}`]);
    this.ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('auto-ping', 'auto-pong'));
    server.serializeAttachment({ connectedAt: Date.now() });
    return new Response(null, { status: 101, webSocket: client });
  }

  async webSocketMessage(ws: WebSocket, message: string | ArrayBuffer): Promise<void> {
    const tags = this.ctx.getTags(ws);
    ws.send(
      JSON.stringify({
        echo: typeof message === 'string' ? message : `<${message.byteLength} bytes>`,
        tags,
        attachment: ws.deserializeAttachment(),
        tagged: this.ctx.getWebSockets('probe-tag').length,
        instanceStartedAt: this.instanceStartedAt,
      })
    );
  }

  async webSocketClose(ws: WebSocket, code: number, reason: string): Promise<void> {
    ws.close(code, reason);
  }
}
