import type {
  ImageResolverConfig,
  ImageResolverDnsLookupFn,
  ImageResolverEnv,
  ImageResolverOptions,
  RegistryAuth,
} from './image-resolver';
import {
  assertResolvedPublic,
  DEFAULT_IMAGE_RESOLVE_DNS_LOOKUP_TIMEOUT_MS,
  DEFAULT_IMAGE_RESOLVE_DNS_RESPONSE_MAX_BYTES,
  DEFAULT_IMAGE_RESOLVE_DOH_RESOLVER_URL,
  DEFAULT_IMAGE_RESOLVE_MAX_DNS_LOOKUPS,
  isBlockedHostname,
} from './image-resolver-network';

export const DEFAULT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS = 10_000;
export const DEFAULT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS = 60_000;
export const DEFAULT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS = 200;
export const DEFAULT_IMAGE_RESOLVE_MAX_REDIRECTS = 2;
export const DEFAULT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES = 65_536;
export const DEFAULT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES = 4;
export const DEFAULT_IMAGE_RESOLVE_MAX_SERVICES = 50;
const OCI_REPOSITORY_SEGMENT_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const OCI_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;

// Non-backtracking: the capture group is forced to start with a non-space
// character so it cannot overlap with the preceding `\s+`.
const BEARER_CHALLENGE_RE = /^Bearer\s+(\S.*)$/i;

const PERCENT_ENCODED_CONTROL_RE = /%(?:0[0-9a-f]|1[0-9a-f]|7f)/i;

interface ResolverFetchBudget {
  attempts: number;
  activeFetches: number;
  dnsLookups: number;
  deadlineAt: number | null;
}

export interface ResolverRuntimeOptions {
  auth?: RegistryAuth;
  authRegistryHost?: string;
  fetchFn: typeof fetch;
  dnsLookupFn: ImageResolverDnsLookupFn;
  config: ImageResolverConfig;
  budget: ResolverFetchBudget;
}

type OutboundUrlKind = 'registry' | 'token realm' | 'redirect' | 'DNS resolver';

export function getImageResolverConfig(env: ImageResolverEnv = {}): ImageResolverConfig {
  return {
    requestTimeoutMs: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS,
      DEFAULT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS
    ),
    totalTimeoutMs: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS,
      DEFAULT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS
    ),
    maxFetchAttempts: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS,
      DEFAULT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS
    ),
    maxRedirects: nonNegativeInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_MAX_REDIRECTS,
      DEFAULT_IMAGE_RESOLVE_MAX_REDIRECTS
    ),
    tokenResponseMaxBytes: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES,
      DEFAULT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES
    ),
    maxConcurrentFetches: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES,
      DEFAULT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES
    ),
    maxServices: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_MAX_SERVICES,
      DEFAULT_IMAGE_RESOLVE_MAX_SERVICES
    ),
    dnsLookupTimeoutMs: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_DNS_LOOKUP_TIMEOUT_MS,
      DEFAULT_IMAGE_RESOLVE_DNS_LOOKUP_TIMEOUT_MS
    ),
    maxDnsLookups: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_MAX_DNS_LOOKUPS,
      DEFAULT_IMAGE_RESOLVE_MAX_DNS_LOOKUPS
    ),
    dnsResponseMaxBytes: positiveInteger(
      env.DEPLOYMENT_IMAGE_RESOLVE_DNS_RESPONSE_MAX_BYTES,
      DEFAULT_IMAGE_RESOLVE_DNS_RESPONSE_MAX_BYTES
    ),
    dohResolverUrl:
      env.DEPLOYMENT_IMAGE_RESOLVE_DOH_RESOLVER_URL ?? DEFAULT_IMAGE_RESOLVE_DOH_RESOLVER_URL,
  };
}

function positiveInteger(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value: string | number | undefined, fallback: number): number {
  const parsed = typeof value === 'number' ? value : Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

export function configFromOptions(opts: ImageResolverOptions): ImageResolverConfig {
  return {
    ...getImageResolverConfig(),
    requestTimeoutMs: positiveInteger(opts.timeoutMs, DEFAULT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS),
    totalTimeoutMs: positiveInteger(opts.totalTimeoutMs, DEFAULT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS),
    maxFetchAttempts: positiveInteger(
      opts.maxFetchAttempts,
      DEFAULT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS
    ),
    maxRedirects: nonNegativeInteger(opts.maxRedirects, DEFAULT_IMAGE_RESOLVE_MAX_REDIRECTS),
    tokenResponseMaxBytes: positiveInteger(
      opts.tokenResponseMaxBytes,
      DEFAULT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES
    ),
    maxConcurrentFetches: positiveInteger(
      opts.maxConcurrentFetches,
      DEFAULT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES
    ),
    dnsLookupTimeoutMs: positiveInteger(
      opts.dnsLookupTimeoutMs,
      DEFAULT_IMAGE_RESOLVE_DNS_LOOKUP_TIMEOUT_MS
    ),
    maxDnsLookups: positiveInteger(opts.maxDnsLookups, DEFAULT_IMAGE_RESOLVE_MAX_DNS_LOOKUPS),
    dnsResponseMaxBytes: positiveInteger(
      opts.dnsResponseMaxBytes,
      DEFAULT_IMAGE_RESOLVE_DNS_RESPONSE_MAX_BYTES
    ),
    dohResolverUrl: opts.dohResolverUrl ?? DEFAULT_IMAGE_RESOLVE_DOH_RESOLVER_URL,
  };
}

function hasUnsafeRawUrlCharacters(value: string): boolean {
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code <= 0x1f || code === 0x7f) {
      return true;
    }
  }
  return PERCENT_ENCODED_CONTROL_RE.test(value);
}

function rawAuthority(input: string): string {
  const match = /^https:\/\/([^/?#]*)/i.exec(input);
  return match?.[1] ?? '';
}

function hostForMessage(url: URL): string {
  return url.hostname.replace(/^\[/, '').replace(/\]$/, '').toLowerCase();
}

function validateOutboundUrl(input: string | URL, kind: OutboundUrlKind): URL {
  const raw = input.toString();
  if (hasUnsafeRawUrlCharacters(raw)) {
    throw new Error(`Unsafe ${kind} URL rejected: control characters are not allowed.`);
  }

  let url: URL;
  try {
    url = input instanceof URL ? input : new URL(raw);
  } catch {
    throw new Error(`Unsafe ${kind} URL rejected: invalid URL.`);
  }

  if (url.protocol !== 'https:') {
    throw new Error(`Unsafe ${kind} URL rejected: only HTTPS endpoints are allowed.`);
  }
  if (url.username || url.password) {
    throw new Error(`Unsafe ${kind} URL rejected: userinfo is not allowed.`);
  }

  const authority = rawAuthority(raw) || rawAuthority(url.toString());
  if (!authority || /[^\x21-\x7E]/.test(authority)) {
    throw new Error(`Unsafe ${kind} URL rejected: ambiguous authority is not allowed.`);
  }
  if (!isCanonicalAuthority(authority, url)) {
    throw new Error(`Unsafe ${kind} URL rejected: ambiguous authority is not allowed.`);
  }

  const hostname = hostForMessage(url);
  if (!hostname || hostname.endsWith('.')) {
    throw new Error(`Unsafe ${kind} URL rejected: trailing-dot or empty host is not allowed.`);
  }
  if (hostname.includes('%')) {
    throw new Error(`Unsafe ${kind} URL rejected: encoded hostnames are not allowed.`);
  }
  if (isBlockedHostname(hostname)) {
    throw new Error(
      `Unsafe ${kind} URL rejected: host ${hostname} is not a public registry endpoint.`
    );
  }

  return url;
}

function isCanonicalAuthority(authority: string, url: URL): boolean {
  const bracketedIpv6 = authority.startsWith('[');
  const portSeparatorIndex = bracketedIpv6
    ? authority.indexOf(']:') === -1
      ? -1
      : authority.indexOf(']:') + 1
    : authority.lastIndexOf(':');
  if (portSeparatorIndex !== -1) {
    const rawPort = authority.slice(portSeparatorIndex + 1);
    if (!/^[1-9][0-9]{0,4}$/.test(rawPort)) return false;
    const parsed = Number.parseInt(rawPort, 10);
    if (parsed > 65_535 || String(parsed) !== rawPort) return false;
  }
  return url.host === url.host.toLowerCase();
}

/**
 * Build the base URL for a registry's v2 API.
 * Handles special cases like docker.io → registry-1.docker.io.
 */
export function registryBaseUrl(registry: string): string {
  if (registry !== registry.trim()) {
    throw new Error('Unsafe registry URL rejected: surrounding whitespace is not allowed.');
  }
  const normalizedRegistry = registry.toLowerCase();
  // Docker Hub uses a different API host
  if (normalizedRegistry === 'docker.io' || normalizedRegistry === 'index.docker.io') {
    return 'https://registry-1.docker.io';
  }
  // Reject plaintext HTTP: registry credentials (Basic auth) must never be sent
  // over an unencrypted channel.
  if (normalizedRegistry.startsWith('http://')) {
    throw new Error(
      `Insecure registry URL rejected: ${registry}. Registry endpoints must use HTTPS.`
    );
  }
  // If the registry already includes an https scheme, use as-is
  if (normalizedRegistry.startsWith('https://')) {
    return validateOutboundUrl(registry.replace(/\/$/, ''), 'registry').origin;
  }
  // Default to HTTPS
  return validateOutboundUrl(`https://${registry}`, 'registry').origin;
}

function authScopeOrigin(registry: string): string {
  return new URL(registryBaseUrl(registry)).origin.toLowerCase();
}

/**
 * Returns true if `auth` credentials scoped to `authRegistryHost` may be sent
 * to a request targeting `registry`. Credentials are only forwarded when the
 * target registry host exactly matches the host the credentials were minted
 * for. When `authRegistryHost` is undefined the caller has explicitly opted
 * out of host scoping and credentials apply to every registry (legacy
 * behavior, used only when the caller fully controls the registry value).
 *
 * This prevents minted SAM registry credentials from being forwarded to an
 * arbitrary, user-controlled registry named in a deployment manifest.
 */
export function authAppliesToRegistry(
  registry: string,
  authRegistryHost: string | undefined
): boolean {
  if (!authRegistryHost) return true;
  try {
    return authScopeOrigin(registry) === authScopeOrigin(authRegistryHost);
  } catch {
    return false;
  }
}

/**
 * Returns true if the token-realm origin is safe for this registry. Keep this
 * narrow: exact origin by default, with explicit compatibility for Docker Hub's
 * documented registry/token split (`registry-1.docker.io` → `auth.docker.io`).
 */
function realmOriginIsTrusted(realm: URL, registryBase: URL): boolean {
  if (realm.origin.toLowerCase() === registryBase.origin.toLowerCase()) return true;
  return (
    registryBase.origin.toLowerCase() === 'https://registry-1.docker.io' &&
    realm.origin.toLowerCase() === 'https://auth.docker.io'
  );
}

function validateRepository(repository: string): string[] {
  if (hasUnsafeRawUrlCharacters(repository) || repository.includes('%')) {
    throw new Error(
      'Unsafe image repository rejected: encoded or control characters are not allowed.'
    );
  }
  if (repository.includes('?') || repository.includes('#') || repository.includes('\\')) {
    throw new Error('Unsafe image repository rejected: URL delimiters are not allowed.');
  }
  const segments = repository.split('/');
  if (
    segments.length === 0 ||
    segments.some((segment) => {
      return (
        segment.length === 0 ||
        segment === '.' ||
        segment === '..' ||
        !OCI_REPOSITORY_SEGMENT_RE.test(segment)
      );
    })
  ) {
    throw new Error('Unsafe image repository rejected: invalid OCI repository path.');
  }
  return segments;
}

function validateTag(tag: string): string {
  if (hasUnsafeRawUrlCharacters(tag) || tag.includes('%')) {
    throw new Error('Unsafe image tag rejected: encoded or control characters are not allowed.');
  }
  if (tag.includes('/') || tag.includes('?') || tag.includes('#') || tag.includes('\\')) {
    throw new Error('Unsafe image tag rejected: URL delimiters are not allowed.');
  }
  if (!OCI_TAG_RE.test(tag)) {
    throw new Error('Unsafe image tag rejected: invalid OCI tag.');
  }
  return tag;
}

export function manifestUrl(base: string, repository: string, tag: string): string {
  const repositoryPath = validateRepository(repository).map(encodeURIComponent).join('/');
  const safeTag = encodeURIComponent(validateTag(tag));
  return `${base}/v2/${repositoryPath}/manifests/${safeTag}`;
}

/**
 * Parse a WWW-Authenticate: Bearer realm="...",service="...",scope="..." header.
 */
export function parseBearerChallenge(
  header: string
): { realm: string; service?: string; scope?: string } | null {
  const match = BEARER_CHALLENGE_RE.exec(header);
  if (!match) return null;

  const [, params] = match;
  if (params === undefined) return null;
  const realm = extractParam(params, 'realm');
  if (!realm) return null;

  return {
    realm,
    service: extractParam(params, 'service'),
    scope: extractParam(params, 'scope'),
  };
}

function extractParam(params: string, key: string): string | undefined {
  const re = new RegExp(`${key}="([^"]*)"`, 'i');
  const m = re.exec(params);
  return m ? m[1] : undefined;
}

function remainingTimeoutMs(config: ImageResolverConfig, budget: ResolverFetchBudget): number {
  const now = Date.now();
  if (budget.deadlineAt === null) {
    budget.deadlineAt = now + config.totalTimeoutMs;
  }
  const remaining = budget.deadlineAt - now;
  if (remaining <= 0) {
    throw new Error(`Image resolution exceeded total time budget of ${config.totalTimeoutMs}ms.`);
  }
  return Math.max(1, Math.min(config.requestTimeoutMs, remaining));
}

function cloneHeaders(headers: HeadersInit | undefined): Headers {
  return new Headers(headers);
}

function redirectLocation(response: Response): string | null {
  if (response.status < 300 || response.status >= 400) return null;
  return response.headers.get('location');
}

type RedirectGuard = (nextUrl: URL, currentUrl: URL) => void;

export async function fetchValidated(
  input: string | URL,
  init: RequestInit,
  runtime: ResolverRuntimeOptions,
  kind: OutboundUrlKind,
  redirectsFollowed = 0,
  redirectGuard?: RedirectGuard
): Promise<Response> {
  const url = validateOutboundUrl(input, kind);
  const { config, budget } = runtime;
  if (budget.attempts >= config.maxFetchAttempts) {
    throw new Error(
      `Image resolution exceeded fetch attempt budget of ${config.maxFetchAttempts}.`
    );
  }
  if (budget.activeFetches >= config.maxConcurrentFetches) {
    throw new Error(
      `Image resolution exceeded concurrent fetch budget of ${config.maxConcurrentFetches}.`
    );
  }

  budget.activeFetches += 1;
  let response: Response;
  let timeoutMs = config.requestTimeoutMs;
  try {
    await assertResolvedPublic(url, runtime, kind);
    timeoutMs = remainingTimeoutMs(config, budget);
    budget.attempts += 1;
    response = await runtime.fetchFn(url.toString(), {
      ...init,
      redirect: 'manual',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
      throw new Error(`Image resolver outbound request timed out after ${timeoutMs}ms.`);
    }
    throw err;
  } finally {
    budget.activeFetches -= 1;
  }

  const location = redirectLocation(response);
  if (!location) {
    return response;
  }
  if (redirectsFollowed >= config.maxRedirects) {
    throw new Error(`Image resolution exceeded redirect budget of ${config.maxRedirects}.`);
  }

  const nextUrl = validateOutboundUrl(
    /^[a-z][a-z0-9+.-]*:/i.test(location) ? location : new URL(location, url),
    'redirect'
  );
  redirectGuard?.(nextUrl, url);
  const nextHeaders = cloneHeaders(init.headers);
  if (nextUrl.origin !== url.origin) {
    nextHeaders.delete('authorization');
    nextHeaders.delete('Authorization');
  }

  return fetchValidated(
    nextUrl,
    {
      ...init,
      headers: nextHeaders,
    },
    runtime,
    'redirect',
    redirectsFollowed + 1,
    redirectGuard
  );
}

async function readTextBounded(
  response: Response,
  maxBytes: number,
  label = 'Token exchange response'
): Promise<string> {
  const contentLength = response.headers.get('content-length');
  if (contentLength) {
    const parsed = Number.parseInt(contentLength, 10);
    if (Number.isFinite(parsed) && parsed > maxBytes) {
      throw new Error(`${label} exceeded ${maxBytes} bytes.`);
    }
  }

  if (!response.body) {
    const text = await response.text();
    if (new TextEncoder().encode(text).byteLength > maxBytes) {
      throw new Error(`${label} exceeded ${maxBytes} bytes.`);
    }
    return text;
  }

  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      total += value.byteLength;
      if (total > maxBytes) {
        throw new Error(`${label} exceeded ${maxBytes} bytes.`);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }

  const combined = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    combined.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return new TextDecoder().decode(combined);
}

/**
 * Exchange credentials for a bearer token using the token endpoint.
 */
export async function fetchBearerToken(
  challenge: { realm: string; service?: string; scope?: string },
  auth: RegistryAuth | undefined,
  registryBase: URL,
  runtime: ResolverRuntimeOptions
): Promise<string> {
  const url = validateOutboundUrl(challenge.realm, 'token realm');

  // The token realm comes from a registry-controlled WWW-Authenticate header.
  // validateOutboundUrl() already requires HTTPS and public-safe authorities.
  // Require the realm host to belong to the registry's domain even without
  // credentials so a malicious registry cannot pivot the Worker into probing
  // arbitrary public control-plane endpoints.
  if (!realmOriginIsTrusted(url, registryBase)) {
    throw new Error(
      `Refusing to use untrusted token realm host ${url.hostname} ` +
        `(registry host ${registryBase.hostname}).`
    );
  }

  if (challenge.service) url.searchParams.set('service', challenge.service);
  if (challenge.scope) url.searchParams.set('scope', challenge.scope);

  const headers: Record<string, string> = {};
  if (auth) {
    const basicCredentials = btoa(`${auth.username}:${auth.password}`);
    headers['Authorization'] = `Basic ${basicCredentials}`;
  }

  const resp = await fetchValidated(
    url,
    {
      method: 'GET',
      headers,
    },
    runtime,
    'token realm',
    0,
    (nextUrl) => {
      if (!realmOriginIsTrusted(nextUrl, registryBase)) {
        throw new Error(
          `Refusing to follow untrusted token realm redirect to ${nextUrl.hostname} ` +
            `(registry host ${registryBase.hostname}).`
        );
      }
    }
  );

  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${resp.statusText}`);
  }

  const body = JSON.parse(
    await readTextBounded(resp, runtime.config.tokenResponseMaxBytes)
  ) as unknown;
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    throw new Error('Token exchange response was not a JSON object');
  }
  const tokenValue = (body as Record<string, unknown>)['token'];
  const accessTokenValue = (body as Record<string, unknown>)['access_token'];
  const token =
    typeof tokenValue === 'string'
      ? tokenValue
      : typeof accessTokenValue === 'string'
        ? accessTokenValue
        : undefined;
  if (!token) {
    throw new Error('Token exchange response missing token field');
  }
  return token;
}
