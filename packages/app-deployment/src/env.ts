import type { ImageResolverEnv } from './image-resolver';

/**
 * Bindings and variables the app-deployment module reads. The worker `Env`
 * extends this interface, so every field must keep the worker's type. The
 * deployment-only tunables are declared only here; shared bindings are also
 * declared on the worker `Env`.
 */
export interface AppDeploymentEnv extends ImageResolverEnv {
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
  COMPOSE_IMAGE_ARTIFACT_MAX_BYTES?: string; // Max single docker-save archive size for R2 compose-publish MVP
  COMPOSE_IMAGE_ARTIFACT_UPLOAD_URL_TTL_SECONDS?: string; // Presigned upload URL TTL for compose image artifacts
  COMPOSE_IMAGE_ARTIFACT_DOWNLOAD_URL_TTL_SECONDS?: string; // Presigned download URL TTL for compose image artifacts
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_ENABLED?: string; // Kill switch: "false" disables abandoned artifact cleanup (default: enabled)
  COMPOSE_IMAGE_ARTIFACT_ABANDONED_RETENTION_HOURS?: string; // Hours to keep unreferenced uploaded artifacts before cleanup (default: 48)
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_BATCH_SIZE?: string; // Max abandoned compose artifacts to delete per cleanup run (default: 250)
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_INTERVAL_HOURS?: string; // Minimum hours between R2 cleanup scans from cron (default: 24)
  COMPOSE_IMAGE_ARTIFACT_CLEANUP_LAST_RUN_KV_KEY?: string; // KV key for cleanup interval gating
}
