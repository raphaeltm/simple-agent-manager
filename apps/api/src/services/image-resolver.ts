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

import {
  authAppliesToRegistry,
  configFromOptions,
  fetchBearerToken,
  fetchValidated,
  manifestUrl,
  parseBearerChallenge,
  registryBaseUrl,
  type ResolverRuntimeOptions,
} from './image-resolver-outbound';

export {
  DEFAULT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES,
  DEFAULT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS,
  DEFAULT_IMAGE_RESOLVE_MAX_REDIRECTS,
  DEFAULT_IMAGE_RESOLVE_MAX_SERVICES,
  DEFAULT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS,
  DEFAULT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES,
  DEFAULT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS,
  getImageResolverConfig,
} from './image-resolver-outbound';

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
  /**
   * Registry host the `auth` credentials belong to. When set, `auth` is ONLY
   * sent to a target registry whose host matches this value — credentials
   * minted for one registry are never forwarded to an unrelated (potentially
   * user-controlled) registry named in the manifest. When unset, `auth`
   * applies to every registry (legacy behavior for explicitly-scoped callers).
   */
  authRegistryHost?: string;
  /** Custom fetch implementation (for testing) */
  fetchFn?: typeof fetch;
  /** Per-request timeout in ms. Default: 10_000 */
  timeoutMs?: number;
  /** Aggregate resolver wall-clock budget in ms. */
  totalTimeoutMs?: number;
  /** Maximum outbound fetch attempts across this resolver instance, including redirects. */
  maxFetchAttempts?: number;
  /** Maximum manually followed redirects per outbound request. */
  maxRedirects?: number;
  /** Maximum bearer-token JSON response body size in bytes. */
  tokenResponseMaxBytes?: number;
  /** Maximum simultaneous outbound fetches for this resolver instance. */
  maxConcurrentFetches?: number;
}

export interface ImageResolverConfig {
  requestTimeoutMs: number;
  totalTimeoutMs: number;
  maxFetchAttempts: number;
  maxRedirects: number;
  tokenResponseMaxBytes: number;
  maxConcurrentFetches: number;
  maxServices: number;
}

export interface ImageResolverEnv {
  DEPLOYMENT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_REDIRECTS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_SERVICES?: string;
}

export class ImageResolveError extends Error {
  constructor(
    message: string,
    public readonly registry: string,
    public readonly repository: string,
    public readonly tag: string,
    public readonly statusCode?: number
  ) {
    super(message);
    this.name = 'ImageResolveError';
  }
}

// =============================================================================
// Constants
// =============================================================================

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
  runtime: ResolverRuntimeOptions
): Promise<string> {
  const base = registryBaseUrl(registry);
  const url = manifestUrl(base, repository, tag);

  const headers: Record<string, string> = {
    Accept: MANIFEST_ACCEPT,
  };

  // Only use credentials when they were minted for this exact registry host.
  // Never forward SAM-minted credentials to an unrelated (potentially
  // user-controlled) registry named in the manifest.
  const auth = authAppliesToRegistry(registry, runtime.authRegistryHost) ? runtime.auth : undefined;

  // Try Basic auth first if credentials provided
  if (auth) {
    const basicCredentials = btoa(`${auth.username}:${auth.password}`);
    headers['Authorization'] = `Basic ${basicCredentials}`;
  }

  let resp = await fetchValidated(
    url,
    {
      method: 'HEAD',
      headers,
    },
    runtime,
    'registry'
  );

  // Handle token-based auth (401 with WWW-Authenticate: Bearer)
  if (resp.status === 401) {
    const wwwAuth = resp.headers.get('www-authenticate');
    if (wwwAuth) {
      const challenge = parseBearerChallenge(wwwAuth);
      if (challenge) {
        const registryBase = new URL(base);
        const token = await fetchBearerToken(challenge, auth, registryBase, runtime);
        headers['Authorization'] = `Bearer ${token}`;
        resp = await fetchValidated(
          url,
          {
            method: 'HEAD',
            headers,
          },
          runtime,
          'registry'
        );
      }
    }
  }

  if (resp.status === 404) {
    throw new ImageResolveError(
      `Image not found: ${registry}/${repository}:${tag}`,
      registry,
      repository,
      tag,
      404
    );
  }

  if (resp.status === 401 || resp.status === 403) {
    throw new ImageResolveError(
      `Authentication failed for ${registry}/${repository}:${tag}. Check registry credentials.`,
      registry,
      repository,
      tag,
      resp.status
    );
  }

  if (!resp.ok) {
    throw new ImageResolveError(
      `Registry returned ${resp.status} for ${registry}/${repository}:${tag}`,
      registry,
      repository,
      tag,
      resp.status
    );
  }

  // Read the digest from the response header
  const digest = resp.headers.get('docker-content-digest');
  if (!digest) {
    // Fallback: some registries only return the digest in a GET response body.
    // Do a GET and compute/read from the response.
    return resolveViaGet(url, headers, registry, repository, tag, runtime);
  }

  if (!SHA256_RE.test(digest)) {
    throw new ImageResolveError(
      `Registry returned unsupported digest format "${digest}" for ${registry}/${repository}:${tag}. Only sha256 digests are supported.`,
      registry,
      repository,
      tag
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
  runtime: ResolverRuntimeOptions
): Promise<string> {
  const resp = await fetchValidated(
    manifestUrl,
    {
      method: 'GET',
      headers,
    },
    runtime,
    'registry'
  );

  if (!resp.ok) {
    throw new ImageResolveError(
      `Registry returned ${resp.status} on manifest GET for ${registry}/${repository}:${tag}`,
      registry,
      repository,
      tag,
      resp.status
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
    tag
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
  const fetchFn = opts.fetchFn ?? ((input, init) => globalThis.fetch(input, init));
  const runtime: ResolverRuntimeOptions = {
    auth: opts.auth,
    authRegistryHost: opts.authRegistryHost,
    fetchFn,
    config: configFromOptions(opts),
    budget: { attempts: 0, activeFetches: 0, deadlineAt: null },
  };
  return (registry: string, repository: string, tag: string) =>
    resolveTagToDigest(registry, repository, tag, runtime);
}

// Re-export for convenience
export type { ImageResolver };
