/**
 * Bindings and variables the app-deployment module reads. The worker `Env`
 * extends this interface, so every field must keep the worker's type.
 */
export interface AppDeploymentEnv {
  DATABASE: D1Database;
  KV: KVNamespace;
  R2: R2Bucket;
  BASE_DOMAIN: string;
  CF_ACCOUNT_ID: string;

  // Custom-domain DNS verification
  DOH_RESOLVER_URL?: string;
  DOH_TIMEOUT_MS?: string;

  // Public route host-port derivation
  DEPLOYMENT_ROUTE_PORT_BASE?: string;
  DEPLOYMENT_ROUTE_PORT_SPAN?: string;

  // Compose image artifacts (R2 presigned uploads and cleanup)
  R2_ACCESS_KEY_ID?: string;
  R2_SECRET_ACCESS_KEY?: string;
  R2_BUCKET_NAME?: string;
  COMPOSE_IMAGE_ARTIFACT_MAX_BYTES?: string;
  COMPOSE_IMAGE_ARTIFACT_UPLOAD_URL_TTL_SECONDS?: string;
  COMPOSE_IMAGE_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS?: string;
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_ENABLED?: string;
  COMPOSE_IMAGE_ARTIFACT_ABANDONED_RETENTION_HOURS?: string;
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_BATCH_SIZE?: string;
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_INTERVAL_HOURS?: string;
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_LAST_RUN_KV_KEY?: string;

  // Release image tag resolution
  DEPLOYMENT_IMAGE_RESOLVE_REQUEST_TIMEOUT_MS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_TOTAL_TIMEOUT_MS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_FETCH_ATTEMPTS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_REDIRECTS?: string;
  DEPLOYMENT_IMAGE_RESOLVE_TOKEN_RESPONSE_MAX_BYTES?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_CONCURRENT_FETCHES?: string;
  DEPLOYMENT_IMAGE_RESOLVE_MAX_SERVICES?: string;
}
