// Spike test Worker: proxies to nodes through frps the way apps/api/src/index.ts
// proxies ws-{id} requests (plain fetch passthrough, WebSocket upgrades included).
//   /probe?url=...                      -> raw egress test (Q1)
//   /tcp/{node}/{path}                  -> http://127.0.0.1:{NODE_PORTS[node]}/{path}   (Q4a)
//   /vhost/{node}/{path}                -> http://127.0.0.1:{FRP_VHOST_PORT}/{path}, Host: {node}.nodes.internal (Q4b)
//   /direct/{port}/{path}               -> http://127.0.0.1:{port}/{path}  (baseline, no tunnel)
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const parts = url.pathname.split('/');
    const mode = parts[1];
    try {
      if (mode === 'probe') {
        const target = url.searchParams.get('url');
        const started = Date.now();
        const res = await fetch(target, { method: 'GET' });
        const body = await res.text();
        return Response.json({ target, status: res.status, ms: Date.now() - started, body: body.slice(0, 300) });
      }
      if (mode === 'hostcheck') {
        // Can a Worker control the Host header on an outbound fetch?
        const res = await fetch(url.searchParams.get('url'), { headers: { Host: url.searchParams.get('host') } });
        return new Response(await res.text(), { status: res.status });
      }
      let base;
      const headers = new Headers(request.headers);
      const rest = '/' + parts.slice(3).join('/') + url.search;
      if (mode === 'tcp') {
        const ports = JSON.parse(env.NODE_PORTS);
        const port = ports[parts[2]];
        if (!port) return new Response('unknown node', { status: 404 });
        base = `http://127.0.0.1:${port}`;
      } else if (mode === 'vhost') {
        base = `http://127.0.0.1:${env.FRP_VHOST_PORT}`;
        headers.set('Host', `${parts[2]}.nodes.internal`);
        headers.set('X-Spike-Node', parts[2]);
      } else if (mode === 'direct') {
        base = `http://127.0.0.1:${parts[2]}`;
      } else {
        return new Response('celld tunnel spike worker\n');
      }
      // Same shape as SAM's ws-{id} proxy: new Request(target, original) and return fetch() result.
      const init = { method: request.method, headers, body: request.body, redirect: 'manual' };
      if (request.body) init.duplex = 'half';
      return await fetch(base + rest, init);
    } catch (err) {
      return Response.json({ error: String(err && err.stack || err) }, { status: 502 });
    }
  },
};
