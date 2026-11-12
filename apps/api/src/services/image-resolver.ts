/** Re-export: this module moved to `src/app-deployment/image-resolver.ts`. */
export type {
  ImageResolver,
  ImageResolverConfig,
  ImageResolverEnv,
  ImageResolverOptions,
  RegistryAuth,
} from '../app-deployment';
export {
  createImageResolver,
  DEFAULT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES,
  DEFAULT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS,
  DEFAULT_IMAGE_RESOLVE_MAX_REDIRECTS,
  DEFAULT_IMAGE_RESOLVE_MAX_SERVICES,
  DEFAULT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS,
  DEFAULT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES,
  DEFAULT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS,
  getImageResolverConfig,
  ImageResolveError,
} from '../app-deployment';
