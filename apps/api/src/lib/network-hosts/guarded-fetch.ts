/**
 * `fetch` for URLs that someone other than the code author chose. It validates the host before
 * the request, never lets the runtime follow a redirect on its own, and re-validates every hop.
 *
 * Why redirects matter: celld (and workerd) follow redirects by default, and the response gives
 * no sign it happened (`redirected` stays false and `url` keeps the first address on celld). A
 * server the caller controls can answer 302 to `http://127.0.0.1:<port>/` or the metadata
 * address, and the internal response comes back as if the public host had sent it.
 *
 * `redirect: 'manual'` is the only value that works on both runtimes: workerd rejects
 * `'error'` and tells the caller to use `'manual'`.
 */
import { classifyHost } from './classify';

/** Redirect hops followed (each one re-validated) before the request is refused. */
export const DEFAULT_OUTBOUND_MAX_REDIRECTS = 3;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/** Headers that carry a credential; dropped when a redirect leaves the original origin. */
const CREDENTIAL_HEADERS = [
  'authorization',
  'proxy-authorization',
  'cookie',
  'x-api-key',
  'api-key',
  'x-goog-api-key',
];

/** Headers that describe a request body; dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language'];

export interface OutboundPolicy {
  /**
   * Allow loopback, private-range and private-network names. Only for an endpoint an operator
   * configured AND explicitly opted in to reaching on the private network. Forbidden hosts
   * (metadata, link-local) are refused regardless.
   */
  allowPrivateNetwork?: boolean;
  /** Redirect hops to follow; 0 refuses every redirect. Default DEFAULT_OUTBOUND_MAX_REDIRECTS. */
  maxRedirects?: number;
  /** Fetch implementation (a budgeted or timed wrapper); the global fetch by default. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** An extra per-hop check, applied after the host check. Throw to refuse the URL. */
  validateUrl?: (url: URL) => void;
}

export type OutboundRefusalReason =
  'invalid_url' | 'scheme' | 'userinfo' | 'host' | 'redirect_limit' | 'redirect_unreplayable';

/** The request was refused before it was sent; nothing reached the refused address. */
export class OutboundRequestRefusedError extends Error {
  constructor(
    readonly reason: OutboundRefusalReason,
    readonly host: string | null,
    message: string
  ) {
    super(message);
    this.name = 'OutboundRequestRefusedError';
  }
}

/**
 * The parsed URL when `policy` allows a request to it. HTTPS to a public host is always allowed;
 * a private host needs `allowPrivateNetwork`; plain HTTP only reaches a private host (credentials
 * never cross the internet unencrypted); forbidden hosts and userinfo are always refused.
 */
export function assertOutboundUrl(input: string | URL, policy: OutboundPolicy = {}): URL {
  let url: URL;
  try {
    url = new URL(String(input));
  } catch {
    throw new OutboundRequestRefusedError('invalid_url', null, 'Outbound URL is not a valid URL');
  }
  const host = url.hostname;
  if (url.protocol !== 'https:' && url.protocol !== 'http:') {
    throw new OutboundRequestRefusedError(
      'scheme',
      host,
      `Outbound scheme ${url.protocol} refused`
    );
  }
  if (url.username || url.password) {
    throw new OutboundRequestRefusedError('userinfo', host, 'Outbound URL carries credentials');
  }
  const hostClass = classifyHost(host);
  if (hostClass === 'forbidden' || (hostClass === 'private' && !policy.allowPrivateNetwork)) {
    throw new OutboundRequestRefusedError(
      'host',
      host,
      `Outbound request to ${hostClass} host ${host} refused`
    );
  }
  if (url.protocol === 'http:' && hostClass !== 'private') {
    throw new OutboundRequestRefusedError(
      'scheme',
      host,
      `Plain HTTP to public host ${host} refused`
    );
  }
  policy.validateUrl?.(url);
  return url;
}

function isReplayableBody(body: RequestInit['body']): boolean {
  return (
    body === undefined ||
    body === null ||
    typeof body === 'string' ||
    body instanceof ArrayBuffer ||
    ArrayBuffer.isView(body) ||
    body instanceof URLSearchParams ||
    body instanceof Blob
  );
}

/** The request for the next hop, following the Fetch standard's method and header rules. */
function nextHopInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  const toGet =
    (status === 303 && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST');
  if (from.origin !== to.origin) for (const name of CREDENTIAL_HEADERS) headers.delete(name);
  if (toGet) {
    for (const name of BODY_HEADERS) headers.delete(name);
    return { ...init, method: 'GET', body: undefined, headers };
  }
  if (!isReplayableBody(init.body)) {
    throw new OutboundRequestRefusedError(
      'redirect_unreplayable',
      to.hostname,
      'Outbound redirect would replay a streamed request body'
    );
  }
  return { ...init, headers };
}

/**
 * Fetches `input` under `policy`: the host is checked before the request, redirects are never
 * followed by the runtime, and each `Location` is checked like the original URL before the next
 * hop. Throws `OutboundRequestRefusedError` for a refused URL or hop; network errors propagate.
 */
export async function guardedFetch(
  input: string | URL,
  init: RequestInit = {},
  policy: OutboundPolicy = {}
): Promise<Response> {
  const maxRedirects = policy.maxRedirects ?? DEFAULT_OUTBOUND_MAX_REDIRECTS;
  let url = assertOutboundUrl(input, policy);
  let request: RequestInit = { ...init, redirect: 'manual' };
  for (let hop = 0; ; hop += 1) {
    const response = policy.fetchFn
      ? await policy.fetchFn(url.toString(), request)
      : await fetch(url.toString(), request);
    const location = REDIRECT_STATUSES.has(response.status)
      ? response.headers.get('location')
      : null;
    if (!location) return response;
    await response.body?.cancel().catch(() => undefined);
    if (hop >= maxRedirects) {
      throw new OutboundRequestRefusedError(
        'redirect_limit',
        url.hostname,
        `Outbound request exceeded ${maxRedirects} redirects`
      );
    }
    let target: URL;
    try {
      target = new URL(location, url);
    } catch {
      throw new OutboundRequestRefusedError(
        'invalid_url',
        url.hostname,
        'Redirect Location is not a URL'
      );
    }
    const next = assertOutboundUrl(target, policy);
    request = nextHopInit(request, response.status, url, next);
    url = next;
  }
}
