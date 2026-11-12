// Moved to @simple-agent-manager/app-deployment (worker modularization W4).
// Re-exported here so existing importers and vi.mock paths stay unchanged.
export type { ResolverRuntimeOptions } from '@simple-agent-manager/app-deployment';
export {
  authAppliesToRegistry,
  configFromOptions,
  DEFAULT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES,
  DEFAULT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS,
  DEFAULT_IMAGE_RESOLVE_MAX_REDIRECTS,
  DEFAULT_IMAGE_RESOLVE_MAX_SERVICES,
  DEFAULT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS,
  DEFAULT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES,
  DEFAULT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS,
  fetchBearerToken,
  fetchValidated,
  getImageResolverConfig,
  manifestUrl,
  parseBearerChallenge,
  registryBaseUrl,
} from '@simple-agent-manager/app-deployment';
