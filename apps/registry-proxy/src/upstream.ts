/**
 * Upstream registry proxying: forwards the (already-authorized) request to the
 * upstream registry with the server-side credential swapped in, and rewrites
 * `Location` headers so blob-upload sessions stay behind the proxy.
 *
 * SPIKE NOTE: upstream auth here is a static Basic credential from env vars.
 * Production mints short-lived Cloudflare registry credentials via the
 * devcontainer-cache pattern (apps/api/src/services/devcontainer-cache.ts)
 * and caches them until expiry.
 */

export interface UpstreamConfig {
  upstreamUrl: string;
  username?: string;
  password?: string;
}

/** Headers we never forward upstream (recomputed by fetch / replaced by us). */
const HOP_HEADERS = ['host', 'authorization', 'connection', 'keep-alive', 'transfer-encoding', 'cf-connecting-ip', 'cf-ray'];

export function buildUpstreamRequest(request: Request, config: UpstreamConfig): Request {
  const incoming = new URL(request.url);
  const upstream = new URL(config.upstreamUrl);
  upstream.pathname = incoming.pathname;
  upstream.search = incoming.search;

  const headers = new Headers();
  request.headers.forEach((value, key) => {
    if (!HOP_HEADERS.includes(key.toLowerCase())) {
      headers.set(key, value);
    }
  });
  if (config.username && config.password) {
    headers.set('Authorization', `Basic ${btoa(`${config.username}:${config.password}`)}`);
  }

  return new Request(upstream.toString(), {
    method: request.method,
    headers,
    body: request.method === 'GET' || request.method === 'HEAD' ? undefined : request.body,
    redirect: 'manual',
    // Streaming request bodies require half-duplex (fetch spec); without this,
    // forwarding blob-upload PATCH/PUT bodies throws in Node and undici.
    duplex: 'half',
  } as RequestInit & { duplex: 'half' });
}

/**
 * Rewrite a Location header returned by the upstream so that follow-up
 * requests (blob upload PATCH/PUT) come back through the proxy.
 * Relative Locations are kept as-is (they already resolve against the proxy).
 * Absolute Locations pointing at the upstream host are re-rooted at the proxy
 * origin. Absolute Locations pointing elsewhere (e.g. signed R2 blob URLs on
 * redirect responses) are passed through untouched.
 */
export function rewriteLocation(location: string, upstreamUrl: string, proxyOrigin: string): string {
  if (location.startsWith('/')) {
    return location;
  }
  let parsed: URL;
  try {
    parsed = new URL(location);
  } catch {
    return location;
  }
  const upstream = new URL(upstreamUrl);
  if (parsed.host === upstream.host) {
    return `${proxyOrigin}${parsed.pathname}${parsed.search}`;
  }
  return location;
}

export async function proxyToUpstream(request: Request, config: UpstreamConfig): Promise<Response> {
  const upstreamRequest = buildUpstreamRequest(request, config);
  const upstreamResponse = await fetch(upstreamRequest);

  const headers = new Headers(upstreamResponse.headers);
  const location = headers.get('location');
  if (location) {
    const proxyOrigin = new URL(request.url).origin;
    headers.set('location', rewriteLocation(location, config.upstreamUrl, proxyOrigin));
  }
  // The upstream's auth challenge must not leak through — the proxy issues its own.
  headers.delete('www-authenticate');

  return new Response(upstreamResponse.body, {
    status: upstreamResponse.status,
    statusText: upstreamResponse.statusText,
    headers,
  });
}
