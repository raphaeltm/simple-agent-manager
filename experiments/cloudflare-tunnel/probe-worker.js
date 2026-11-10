// Isolated transport probe; deliberately has no SAM bindings or user data.
export default {
  async fetch(request, env) {
    if (request.headers.get('X-Probe-Key') !== env.PROBE_KEY) {
      return new Response('Unauthorized', { status: 401 });
    }
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/(vm|flat)\/(443|8443)(\/.*)$/);
    if (!match) return new Response('Not found', { status: 404 });
    const host = match[1] === 'vm' ? env.VM_HOST : env.FLAT_HOST;
    const headers = new Headers(request.headers);
    headers.delete('X-Probe-Key');
    headers.set('Authorization', `Bearer ${env.ORIGIN_KEY}`);
    headers.set('X-SAM-Proxied-Request', 'true');
    headers.set('X-Forwarded-Host', url.host);
    if (match[3].startsWith('/agent/')) {
      const mode = headers.get('X-Probe-Auth-Mode') || 'valid';
      headers.delete('X-Probe-Auth-Mode');
      headers.delete('Authorization');
      headers.delete('Cookie');
      url.searchParams.delete('token');
      const tokens = JSON.parse(env.AGENT_TOKENS);
      if (Object.hasOwn(tokens, mode)) url.searchParams.set('token', tokens[mode]);
      if (mode === 'invalid') url.searchParams.set('token', 'invalid');
    }
    const target = `https://${host}:${match[2]}${match[3]}${url.search}`;
    try {
      return await fetch(new Request(target, {
        method: request.method, headers, body: request.body, redirect: 'manual',
      }));
    } catch {
      return new Response('Upstream fetch failed', { status: 502 });
    }
  },
};
