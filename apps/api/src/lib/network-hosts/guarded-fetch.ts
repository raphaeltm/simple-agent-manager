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

/**
 * Redirect hops followed (each one re-validated) before the request is refused. Callers pass the
 * admin setting `outbound.maxRedirects` (services/outbound-fetch-settings.ts); this is its default.
 */
export const DEFAULT_OUTBOUND_MAX_REDIRECTS = 3;

/** Upper bound for `outbound.maxRedirects`; the Fetch standard itself stops at 20. */
export const MAX_OUTBOUND_REDIRECTS = 10;

const REDIRECT_STATUSES = new Set([301, 302, 303, 307, 308]);

/**
 * The only request headers kept on a hop that leaves the original origin. Every other header is
 * dropped: any credential under any name (Authorization, PRIVATE-TOKEN, x-api-key, cookies,
 * provider keys) and every provider-specific header. A list of what is safe cannot miss a new
 * credential header the way a list of credentials can.
 * - accept, accept-language: content negotiation; they say nothing about the caller.
 * - content-type, content-language: describe the body a 307/308 replays, which the new origin
 *   cannot parse without them. Dropped anyway when the hop turns the request into a GET.
 * - user-agent: the runtime's default otherwise; it names software, not a person or account.
 */
const CROSS_ORIGIN_SAFE_HEADERS = new Set([
  'accept',
  'accept-language',
  'content-type',
  'content-language',
  'user-agent',
]);

/** Headers that describe a request body; dropped when a redirect turns the request into a GET. */
const BODY_HEADERS = ['content-type', 'content-length', 'content-encoding', 'content-language'];

export interface OutboundPolicy {
  /**
   * Allow loopback, private-range and private-network names. Only for an endpoint an operator
   * configured AND explicitly opted in to reaching on the private network. Redirect hops to a
   * private host are allowed only on the original origin. Forbidden hosts (metadata,
   * link-local) are refused regardless.
   */
  allowPrivateNetwork?: boolean;
  /** Redirect hops to follow; 0 refuses every redirect. Default DEFAULT_OUTBOUND_MAX_REDIRECTS. */
  maxRedirects?: number;
  /**
   * One deadline in milliseconds for the whole operation: every hop, until the final response's
   * headers arrive. It never cuts the final body (a stream keeps going). A caller's own
   * `init.signal` also spans every hop. Omitted: no deadline beyond the caller's signal.
   */
  deadlineMs?: number;
  /** Fetch implementation (a budgeted wrapper); the global fetch by default. */
  fetchFn?: (url: string, init: RequestInit) => Promise<Response>;
  /** An extra per-hop check, applied after the host check. Throw to refuse the URL. */
  validateUrl?: (url: URL) => void;
}

export type OutboundRefusalReason =
  | 'invalid_url'
  | 'scheme'
  | 'userinfo'
  | 'host'
  | 'redirect_limit'
  | 'redirect_unreplayable'
  | 'deadline';

/** The request was refused before it was sent, or its deadline passed between hops. */
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

function keepOnlySafeHeaders(headers: Headers): void {
  for (const name of [...headers.keys()]) {
    if (!CROSS_ORIGIN_SAFE_HEADERS.has(name)) headers.delete(name);
  }
}

/** The request for the next hop, following the Fetch standard's method and header rules. */
function nextHopInit(init: RequestInit, status: number, from: URL, to: URL): RequestInit {
  const headers = new Headers(init.headers);
  const method = (init.method ?? 'GET').toUpperCase();
  const toGet =
    (status === 303 && method !== 'HEAD') ||
    ((status === 301 || status === 302) && method === 'POST');
  if (from.origin !== to.origin) keepOnlySafeHeaders(headers);
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

function parseLocation(location: string, url: URL): URL {
  try {
    return new URL(location, url);
  } catch {
    throw new OutboundRequestRefusedError(
      'invalid_url',
      url.hostname,
      'Redirect Location is not a URL'
    );
  }
}

/** The validated next hop for a redirect response, or null when `response` is the final one. */
async function nextHopUrl(
  response: Response,
  url: URL,
  hop: number,
  policy: OutboundPolicy,
  origin: string
): Promise<URL | null> {
  const location = REDIRECT_STATUSES.has(response.status)
    ? response.headers.get('location')
    : null;
  if (!location) return null;
  await response.body?.cancel().catch(() => undefined);
  const maxRedirects = policy.maxRedirects ?? DEFAULT_OUTBOUND_MAX_REDIRECTS;
  if (hop >= maxRedirects) {
    throw new OutboundRequestRefusedError(
      'redirect_limit',
      url.hostname,
      `Outbound request exceeded ${maxRedirects} redirects`
    );
  }
  const target = parseLocation(location, url);
  // The private-network opt-in covers the configured endpoint, not wherever it redirects: a
  // hop to a private host must stay on the original origin.
  return assertOutboundUrl(target, {
    ...policy,
    allowPrivateNetwork: policy.allowPrivateNetwork === true && target.origin === origin,
  });
}

interface OperationSignal {
  signal: AbortSignal | undefined;
  /** Stops the deadline once the final response is in hand, so the body is never cut by it. */
  settle: () => void;
  expired: () => boolean;
}

/** A signal that aborts on the caller's signal or when `deadlineMs` passes. */
function operationSignal(
  callerSignal: AbortSignal | null | undefined,
  deadlineMs: number | undefined
): OperationSignal {
  if (deadlineMs === undefined) {
    return { signal: callerSignal ?? undefined, settle: () => undefined, expired: () => false };
  }
  const controller = new AbortController();
  let timedOut = false;
  const timer = setTimeout(() => {
    timedOut = true;
    controller.abort(new DOMException('Outbound request deadline exceeded', 'TimeoutError'));
  }, deadlineMs);
  const forward = () => controller.abort(callerSignal?.reason);
  if (callerSignal?.aborted) forward();
  else callerSignal?.addEventListener('abort', forward, { once: true });
  // The caller's signal stays linked after settle: it may still cancel the final body.
  return { signal: controller.signal, settle: () => clearTimeout(timer), expired: () => timedOut };
}

/**
 * Fetches `input` under `policy`: the host is checked before the request, redirects are never
 * followed by the runtime, and each `Location` is checked like the original URL before the next
 * hop. Throws `OutboundRequestRefusedError` for a refused URL or hop, or when `deadlineMs` passes
 * before the final response; other network errors propagate.
 */
export async function guardedFetch(
  input: string | URL,
  init: RequestInit = {},
  policy: OutboundPolicy = {}
): Promise<Response> {
  let url = assertOutboundUrl(input, policy);
  const origin = url.origin;
  const operation = operationSignal(init.signal, policy.deadlineMs);
  let request: RequestInit = { ...init, signal: operation.signal, redirect: 'manual' };
  try {
    for (let hop = 0; ; hop += 1) {
      const response = policy.fetchFn
        ? await policy.fetchFn(url.toString(), request)
        : await fetch(url.toString(), request);
      const next = await nextHopUrl(response, url, hop, policy, origin);
      if (!next) return response;
      request = nextHopInit(request, response.status, url, next);
      url = next;
    }
  } catch (err) {
    if (operation.expired() && !(err instanceof OutboundRequestRefusedError)) {
      throw new OutboundRequestRefusedError(
        'deadline',
        url.hostname,
        `Outbound request did not complete within ${policy.deadlineMs} ms`
      );
    }
    throw err;
  } finally {
    operation.settle();
  }
}
