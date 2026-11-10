// Spike test Worker: proxies to nodes through frps the way apps/api/src/index.ts
// proxies ws-{id} requests (plain fetch passthrough, WebSocket upgrades included).
//   /probe?url=...                      -> raw egress test (Q1)
//   /tcp/{node}/{path}                  -> http://127.0.0.1:{NODE_PORTS[node]}/{path}   (Q4a)
//   /vhost/{node}/{path}                -> http://127.0.0.1:{FRP_VHOST_PORT}/{path}, Host: {node}.nodes.internal (Q4b)
//   /direct/{port}/{path}               -> http://127.0.0.1:{port}/{path}  (baseline, no tunnel)
export default {
  async fetch(request, env, ctx) {
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
      if (mode === 'fwdauth') {
        // Caddy forward_auth target: decide auth in the Worker, return the node's loopback upstream
        // in a header so Caddy proxies the WebSocket itself (data path bypasses celld).
        const node = request.headers.get('x-forwarded-host')?.split('.')[0]?.replace(/^ws-/, '');
        const ports = JSON.parse(env.NODE_PORTS);
        if (request.headers.get('x-spike-auth') !== 'let-me-in' && !(request.headers.get('x-forwarded-uri') || '').includes('auth=let-me-in')) return new Response('unauthorized', { status: 401 });
        if (!ports[node]) return new Response('unknown node', { status: 404 });
        return new Response(null, { status: 200, headers: { 'X-Node-Upstream': `127.0.0.1:${ports[node]}` } });
      }
      if (mode === 'localws') {
        // Worker-terminated WebSocket (no upstream): does celld complete a handshake at all?
        const [client, server] = Object.values(new WebSocketPair()); server.accept();
        server.send('hello from worker');
        server.addEventListener('message', (e) => server.send(e.data));
        return new Response(null, { status: 101, webSocket: client });
      }
      if (mode === 'wsupstream') {
        // Does the fetch()-obtained upstream WebSocket actually carry frames? Also try new WebSocket(url).
        const target = url.searchParams.get('url'); const out = {};
        const firstMessage = (ws) => new Promise((ok) => { ws.addEventListener('message', (e) => ok(String(e.data))); ws.addEventListener('close', (e) => ok('closed ' + e.code)); ws.addEventListener('error', (e) => ok('error ' + (e.message || e))); setTimeout(() => ok('no message in 3s'), 3000); });
        try {
          const h = { Upgrade: 'websocket' }; if (url.searchParams.get('host')) h.Host = url.searchParams.get('host');
          const res = await fetch(target.replace('ws://', 'http://'), { headers: h });
          const ws = res.webSocket; out.fetchStatus = res.status; out.keys = Object.keys(ws || {}).concat(Object.getOwnPropertyNames(Object.getPrototypeOf(ws || {})));
          ws.accept(); const p = firstMessage(ws); out.fetchFirst = await p;
          ws.send('ping-from-worker'); out.fetchEcho = await firstMessage(ws); ws.close(1000);
        } catch (e) { out.fetchError = String(e.stack || e); }
        try {
          const ws2 = new WebSocket(target); out.ctor = 'ok';
          out.ctorFirst = await firstMessage(ws2); ws2.send('ping2'); out.ctorEcho = await firstMessage(ws2); ws2.close(1000);
        } catch (e) { out.ctorError = String(e.stack || e); }
        return Response.json(out);
      }
      if (mode === 'wsdebug') {
        const res = await fetch(url.searchParams.get('url'), { headers: { Upgrade: 'websocket', Connection: 'Upgrade', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': 'dGhlIHNhbXBsZSBub25jZQ==' } });
        return Response.json({ status: res.status, headers: [...res.headers], hasWebSocket: !!res.webSocket, wsType: res.webSocket && Object.prototype.toString.call(res.webSocket), hasPair: typeof WebSocketPair });
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
      // ?_hdr=strip removes hop-by-hop WebSocket handshake headers before the outbound fetch.
      if (url.searchParams.get('_hdr') === 'strip' && headers.get('upgrade')) {
        for (const h of [...headers.keys()]) if (h.startsWith('sec-websocket-') || h === 'connection') headers.delete(h);
        headers.set('Upgrade', 'websocket');
      }
      const init = { method: request.method, headers, body: request.body, redirect: 'manual' };
      if (request.body) init.duplex = 'half';
      // ?_ws=raw (default, SAM's shape: return the fetch() result) | rewrap | pair
      const wsMode = url.searchParams.get('_ws') || 'raw';
      const res = await fetch(base + rest, init);
      if (res.status !== 101 || !res.webSocket || wsMode === 'raw') return res;
      if (wsMode === 'rewrap') return new Response(null, { status: 101, webSocket: res.webSocket });
      // pair: terminate both sides in the Worker and pump frames (costs isolate memory / queue budget)
      const upstream = res.webSocket; upstream.accept();
      const [client, server] = Object.values(new WebSocketPair()); server.accept();
      server.addEventListener('message', (e) => upstream.send(e.data));
      upstream.addEventListener('message', (e) => server.send(e.data));
      server.addEventListener('close', (e) => { try { upstream.close(e.code, e.reason); } catch {} });
      upstream.addEventListener('close', (e) => { try { server.close(e.code, e.reason); } catch {} });
      // A dead tunnel surfaces as 'error' (or nothing); close the other side with 1011 so the client learns.
      upstream.addEventListener('error', () => { console.log('bridge: upstream error'); try { server.close(1011, 'upstream error'); } catch {} });
      server.addEventListener('error', () => { try { upstream.close(1011, 'client error'); } catch {} });
      // ?_wait=1 keeps the invocation alive until either side closes.
      if (url.searchParams.get('_wait')) ctx.waitUntil(new Promise((done) => { for (const ws of [server, upstream]) for (const ev of ['close', 'error']) ws.addEventListener(ev, done); }));
      return new Response(null, { status: 101, webSocket: client });
    } catch (err) {
      return Response.json({ error: String(err && err.stack || err) }, { status: 502 });
    }
  },
};
