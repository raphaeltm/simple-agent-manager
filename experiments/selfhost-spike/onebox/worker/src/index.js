// Minimal celld one-box test Worker: SQLite DO + alarm + hibernatable WebSocket,
// D1, KV, R2, cron, vars/secrets probe, header echo. Throwaway spike code.
import { DurableObject } from 'cloudflare:workers';

const ALARM_MS = 15_000;
const json = (v, init = {}) => new Response(JSON.stringify(v, null, 1), { ...init, headers: { 'content-type': 'application/json', ...(init.headers || {}) } });

export class Box extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS w (k TEXT PRIMARY KEY, t INTEGER NOT NULL)`);
    ctx.storage.sql.exec(`CREATE TABLE IF NOT EXISTS alarms (fired_at INTEGER NOT NULL, scheduled INTEGER)`);
  }
  async fetch(req) {
    const u = new URL(req.url);
    if (u.pathname.endsWith('/ws')) {
      const [client, server] = Object.values(new WebSocketPair());
      this.ctx.acceptWebSocket(server, ['spike']);
      return new Response(null, { status: 101, webSocket: client });
    }
    if (u.pathname.endsWith('/write')) {
      const k = u.searchParams.get('k');
      this.ctx.storage.sql.exec(`INSERT INTO w (k, t) VALUES (?, ?)`, k, Date.now());
      return json({ ok: true, k });
    }
    if (u.pathname.endsWith('/keys')) {
      const rows = this.ctx.storage.sql.exec(`SELECT k FROM w`).toArray().map((r) => r.k);
      return json({ count: rows.length, keys: rows });
    }
    if (u.pathname.endsWith('/arm')) {
      const at = Date.now() + ALARM_MS;
      await this.ctx.storage.setAlarm(at);
      return json({ armed: at });
    }
    if (u.pathname.endsWith('/state')) {
      const count = this.ctx.storage.sql.exec(`SELECT count(*) AS c FROM w`).one().c;
      const alarms = this.ctx.storage.sql.exec(`SELECT fired_at, scheduled FROM alarms ORDER BY fired_at DESC LIMIT 5`).toArray();
      const nalarms = this.ctx.storage.sql.exec(`SELECT count(*) AS c FROM alarms`).one().c;
      return json({ count, nalarms, alarms, nextAlarm: await this.ctx.storage.getAlarm() });
    }
    return json({ error: 'unknown DO path' }, { status: 404 });
  }
  async alarm(info) {
    const now = Date.now();
    this.ctx.storage.sql.exec(`INSERT INTO alarms (fired_at, scheduled) VALUES (?, ?)`, now, info?.scheduledTime ?? null);
    await this.ctx.storage.setAlarm(now + ALARM_MS); // self-rearming
  }
  webSocketMessage(ws, msg) {
    ws.send(`echo:${msg}`);
  }
  webSocketClose(ws, code, reason) {
    ws.close(code, reason);
  }
}

export default {
  async fetch(req, env, ctx) {
    const u = new URL(req.url);
    const p = u.pathname;
    // Option B (item 5): the SPA rides in the same Worker via the assets binding.
    // run_worker_first=true, so the Worker dispatches by host; api/ws hosts never see SPA files.
    if (env.ASSETS && u.hostname.startsWith('app-assets.')) return env.ASSETS.fetch(req);
    if (p === '/' || p === '/healthz') return json({ ok: true, host: u.host, url: req.url, app: env.APP_NAME });
    if (p.startsWith('/do/')) {
      const name = u.searchParams.get('name') || 'default';
      const stub = env.BOX.get(env.BOX.idFromName(name));
      return stub.fetch(req);
    }
    if (p === '/d1/init') {
      // celld dev has no `d1 migrations apply`; mirror migrations/0001_init.sql here.
      await env.DB.exec(`CREATE TABLE IF NOT EXISTS writes (k TEXT PRIMARY KEY, v TEXT, t INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS cron_runs (scheduled_time INTEGER PRIMARY KEY, ran_at INTEGER NOT NULL);`);
      return json({ ok: true });
    }
    if (p === '/d1/write') {
      const k = u.searchParams.get('k');
      const r = await env.DB.prepare(`INSERT INTO writes (k, v, t) VALUES (?, ?, ?)`).bind(k, 'x', Date.now()).run();
      return json({ ok: true, k, changes: r.meta.changes });
    }
    if (p === '/d1/keys') {
      const r = await env.DB.prepare(`SELECT k FROM writes`).all();
      return json({ count: r.results.length, keys: r.results.map((x) => x.k) });
    }
    if (p === '/cron') {
      const r = await env.DB.prepare(`SELECT scheduled_time, ran_at FROM cron_runs ORDER BY scheduled_time DESC LIMIT 20`).all();
      return json(r.results.map((x) => ({ scheduled: new Date(x.scheduled_time).toISOString(), ran: new Date(x.ran_at).toISOString() })));
    }
    if (p === '/kv') {
      const k = u.searchParams.get('k');
      if (req.method === 'PUT') { await env.KV.put(k, await req.text()); return json({ ok: true }); }
      return json({ k, v: await env.KV.get(k) });
    }
    if (p === '/r2list') {
      const r = await env.FILES.list({ prefix: u.searchParams.get('prefix') || '', include: ['httpMetadata', 'customMetadata'] });
      return json(r.objects.map((o) => ({ key: o.key, size: o.size, etag: o.etag, ct: o.httpMetadata?.contentType, meta: o.customMetadata })));
    }
    if (p.startsWith('/r2/')) {
      const key = decodeURIComponent(p.slice(4));
      if (req.method === 'PUT') {
        const meta = {};
        for (const [h, v] of req.headers) if (h.startsWith('x-meta-')) meta[h.slice(7)] = v;
        const obj = await env.FILES.put(key, req.body, { httpMetadata: { contentType: req.headers.get('content-type') || undefined }, customMetadata: meta });
        return json({ ok: true, key: obj.key, size: obj.size, etag: obj.etag });
      }
      if (req.method === 'HEAD' || u.searchParams.has('head')) {
        const h = await env.FILES.head(key);
        if (!h) return json({ found: false }, { status: 404 });
        return json({ found: true, key: h.key, size: h.size, etag: h.etag, httpMetadata: h.httpMetadata, customMetadata: h.customMetadata, uploaded: h.uploaded });
      }
      const o = await env.FILES.get(key);
      if (!o) return new Response('not found', { status: 404 });
      return new Response(o.body, { headers: { 'content-type': o.httpMetadata?.contentType || 'application/octet-stream', 'x-size': String(o.size), 'x-etag': o.etag } });
    }
    if (p === '/env') {
      // Report presence and length only; never echo secret values.
      const out = {};
      for (const [k, v] of Object.entries(env)) out[k] = typeof v === 'string' ? { type: 'string', length: v.length } : typeof v;
      return json(out);
    }
    if (p === '/headers') {
      return json({ url: req.url, headers: Object.fromEntries(req.headers) });
    }
    if (p === '/outbound') {
      const target = u.searchParams.get('url');
      try { const r = await fetch(target); return json({ status: r.status, body: (await r.text()).slice(0, 200) }); }
      catch (e) { return json({ error: String(e) }, { status: 502 }); }
    }
    return json({ error: 'not found' }, { status: 404 });
  },
  async scheduled(controller, env, ctx) {
    await env.DB.prepare(`INSERT OR IGNORE INTO cron_runs (scheduled_time, ran_at) VALUES (?, ?)`).bind(controller.scheduledTime, Date.now()).run();
  },
};
