/**
 * OCI Image Resolver — resolves tag-based image references to digest-pinned references.
 *
 * Implements the ImageResolver interface from @simple-agent-manager/shared
 * by querying the OCI Distribution Spec manifest endpoint:
 *   HEAD /v2/{name}/manifests/{reference}
 *
 * The response's `Docker-Content-Digest` header contains the immutable digest.
 *
 * Supports:
 * - Public registries (no auth)
 * - Private registries with username/password (Basic auth)
 * - Token-based auth via WWW-Authenticate → token exchange
 */

import type { ImageResolver } from '@simple-agent-manager/shared';

// =============================================================================
// Types
// =============================================================================

export interface RegistryAuth {
  username: string;
  password: string;
}

export interface ImageResolverOptions {
  /** Optional auth for private registries */
  auth?: RegistryAuth;
  /** Custom fetch implementation (for testing) */
  fetchFn?: typeof fetch;
  /** Request timeout in ms. Default: 10_000 */
  timeoutMs?: number;
}

export class ImageResolveError extends Error {
  constructor(
    message: string,
    public readonly registry: string,
    public readonly repository: string,
    public readonly tag: string,
    public readonly statusCode?: number,
  ) {
    super(message);
    this.name = 'ImageResolveError';
  }
}

// =============================================================================
// Constants
// =============================================================================

const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Accept headers for OCI/Docker manifest content negotiation.
 * We request both OCI and Docker manifest types to maximize compatibility.
 */
const MANIFEST_ACCEPT = [
  'application/vnd.oci.image.manifest.v1+json',
  'application/vnd.oci.image.index.v1+json',
  'application/vnd.docker.distribution.manifest.v2+json',
  'application/vnd.docker.distribution.manifest.list.v2+json',
].join(', ');

const SHA256_RE = /^sha256:[a-f0-9]{64}$/;

// Non-backtracking: the capture group is forced to start with a non-space
// character so it cannot overlap with the preceding `\s+`.
const BEARER_CHALLENGE_RE = /^Bearer\s+(\S.*)$/i;

// =============================================================================
// Registry URL resolution
// =============================================================================

/**
 * Build the base URL for a registry's v2 API.
 * Handles special cases like docker.io → registry-1.docker.io.
 */
function registryBaseUrl(registry: string): string {
  // Docker Hub uses a different API host
  if (registry === 'docker.io' || registry === 'index.docker.io') {
    return 'https://registry-1.docker.io';
  }
  // If the registry already includes a scheme, use as-is
  if (registry.startsWith('http://') || registry.startsWith('https://')) {
    return registry.replace(/\/$/, '');
  }
  // Default to HTTPS
  return `https://${registry}`;
}

// =============================================================================
// Token auth (for registries that use WWW-Authenticate challenges)
// =============================================================================

/**
 * Parse a WWW-Authenticate: Bearer realm="...",service="...",scope="..." header.
 */
function parseBearerChallenge(header: string): { realm: string; service?: string; scope?: string } | null {
  const match = BEARER_CHALLENGE_RE.exec(header);
  if (!match) return null;

  const params = match[1]!;
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

/**
 * Exchange credentials for a bearer token using the token endpoint.
 */
async function fetchBearerToken(
  challenge: { realm: string; service?: string; scope?: string },
  auth: RegistryAuth | undefined,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const url = new URL(challenge.realm);
  if (challenge.service) url.searchParams.set('service', challenge.service);
  if (challenge.scope) url.searchParams.set('scope', challenge.scope);

  const headers: Record<string, string> = {};
  if (auth) {
    const basicCredentials = btoa(`${auth.username}:${auth.password}`);
    headers['Authorization'] = `Basic ${basicCredentials}`;
  }

  const resp = await fetchFn(url.toString(), {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new Error(`Token exchange failed: ${resp.status} ${resp.statusText}`);
  }

  const body = await resp.json() as { token?: string; access_token?: string };
  const token = body.token ?? body.access_token;
  if (!token) {
    throw new Error('Token exchange response missing token field');
  }
  return token;
}

// =============================================================================
// Core resolver
// =============================================================================

/**
 * Resolve a single image tag to a digest by querying the registry.
 *
 * Algorithm:
 * 1. HEAD /v2/{repo}/manifests/{tag} with Accept headers
 * 2. If 401 with WWW-Authenticate: Bearer, do token exchange and retry
 * 3. Read Docker-Content-Digest header from the response
 */
async function resolveTagToDigest(
  registry: string,
  repository: string,
  tag: string,
  opts: ImageResolverOptions,
): Promise<string> {
  const fetchFn = opts.fetchFn ?? fetch;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const base = registryBaseUrl(registry);
  const manifestUrl = `${base}/v2/${repository}/manifests/${tag}`;

  const headers: Record<string, string> = {
    Accept: MANIFEST_ACCEPT,
  };

  // Try Basic auth first if credentials provided
  if (opts.auth) {
    const basicCredentials = btoa(`${opts.auth.username}:${opts.auth.password}`);
    headers['Authorization'] = `Basic ${basicCredentials}`;
  }

  let resp = await fetchFn(manifestUrl, {
    method: 'HEAD',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  // Handle token-based auth (401 with WWW-Authenticate: Bearer)
  if (resp.status === 401) {
    const wwwAuth = resp.headers.get('www-authenticate');
    if (wwwAuth) {
      const challenge = parseBearerChallenge(wwwAuth);
      if (challenge) {
        const token = await fetchBearerToken(challenge, opts.auth, fetchFn, timeoutMs);
        headers['Authorization'] = `Bearer ${token}`;
        resp = await fetchFn(manifestUrl, {
          method: 'HEAD',
          headers,
          signal: AbortSignal.timeout(timeoutMs),
        });
      }
    }
  }

  if (resp.status === 404) {
    throw new ImageResolveError(
      `Image not found: ${registry}/${repository}:${tag}`,
      registry,
      repository,
      tag,
      404,
    );
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ImageResolveError(
      `Authentication failed for ${registry}/${repository}:${tag}. Check registry credentials.`,
      registry,
      repository,
      tag,
      resp.status,
    );
  }

  if (!resp.ok) {
    throw new ImageResolveError(
      `Registry returned ${resp.status} for ${registry}/${repository}:${tag}`,
      registry,
      repository,
      tag,
      resp.status,
    );
  }

  // Read the digest from the response header
  const digest = resp.headers.get('docker-content-digest');
  if (!digest) {
    // Fallback: some registries only return the digest in a GET response body.
    // Do a GET and compute/read from the response.
    return resolveViaGet(manifestUrl, headers, registry, repository, tag, fetchFn, timeoutMs);
  }

  if (!SHA256_RE.test(digest)) {
    throw new ImageResolveError(
      `Registry returned unsupported digest format "${digest}" for ${registry}/${repository}:${tag}. Only sha256 digests are supported.`,
      registry,
      repository,
      tag,
    );
  }

  return digest;
}

/**
 * Fallback: GET the manifest and read Docker-Content-Digest from the response.
 * Some registries (notably Docker Hub) don't return the digest on HEAD.
 */
async function resolveViaGet(
  manifestUrl: string,
  headers: Record<string, string>,
  registry: string,
  repository: string,
  tag: string,
  fetchFn: typeof fetch,
  timeoutMs: number,
): Promise<string> {
  const resp = await fetchFn(manifestUrl, {
    method: 'GET',
    headers,
    signal: AbortSignal.timeout(timeoutMs),
  });

  if (!resp.ok) {
    throw new ImageResolveError(
      `Registry returned ${resp.status} on manifest GET for ${registry}/${repository}:${tag}`,
      registry,
      repository,
      tag,
      resp.status,
    );
  }

  const digest = resp.headers.get('docker-content-digest');
  if (digest && SHA256_RE.test(digest)) {
    return digest;
  }

  throw new ImageResolveError(
    `Registry did not return a Docker-Content-Digest header for ${registry}/${repository}:${tag}. Cannot pin image to a digest.`,
    registry,
    repository,
    tag,
  );
}

// =============================================================================
// Factory
// =============================================================================

/**
 * Create an ImageResolver function for use with resolveManifest().
 *
 * @param opts - Optional auth and fetch configuration
 * @returns An ImageResolver that queries the OCI registry manifest API
 */
export function createImageResolver(opts: ImageResolverOptions = {}): ImageResolver {
  return (registry: string, repository: string, tag: string) =>
    resolveTagToDigest(registry, repository, tag, opts);
}

// Re-export for convenience
export type { ImageResolver };
