// Probe: does celld offer cloudflare:sockets connect(), and can fetch() send CONNECT? (tcpmux needs one of them)
async function rawExchange(connect, port, payload) {
  const s = connect({ hostname: '127.0.0.1', port });
  const w = s.writable.getWriter();
  await w.write(new TextEncoder().encode(payload));
  const r = s.readable.getReader(); let text = '';
  const deadline = Date.now() + 3000;
  while (Date.now() < deadline) {
    const res = await Promise.race([r.read(), new Promise((ok) => setTimeout(() => ok({ timeout: true }), 1000))]);
    if (res.timeout || res.done) break;
    text += new TextDecoder().decode(res.value);
  }
  try { s.close(); } catch {}
  return text;
}
export default {
  async fetch(request) {
    const only = new URL(request.url).searchParams.get('only');
    const out = {};
    if (only === 'import' || only === 'plain' || only === 'mux') {
      try {
        const mod = await import('cloudflare:sockets');
        out.socketsModule = Object.keys(mod);
        if (only === 'plain') out.plain = await rawExchange(mod.connect, 17001, 'GET /health HTTP/1.1\r\nHost: x\r\nConnection: close\r\n\r\n');
        if (only === 'mux') out.mux = await rawExchange(mod.connect, 7490, 'CONNECT node-a.nodes.internal:80 HTTP/1.1\r\nHost: node-a.nodes.internal:80\r\n\r\nGET /health HTTP/1.1\r\nHost: node-a.nodes.internal\r\nConnection: close\r\n\r\n');
      } catch (e) { out.socketsError = String(e); }
    }
    if (only === 'connect') {
      try { out.connectFetch = (await fetch('http://127.0.0.1:7490/', { method: 'CONNECT' })).status; } catch (e) { out.connectFetchError = String(e); }
    }
    return Response.json(out);
  },
};
