// =============================================================================
// Hetzner Configuration
// =============================================================================

/** Default Hetzner datacenter. Override via HETZNER_DATACENTER env var. */
export const DEFAULT_HETZNER_DATACENTER = 'fsn1';

/** Default Hetzner image. Override via HETZNER_IMAGE env var. */
export const DEFAULT_HETZNER_IMAGE = 'ubuntu-24.04';

/** Backwards compatibility alias - use DEFAULT_HETZNER_IMAGE */
export const HETZNER_IMAGE = DEFAULT_HETZNER_IMAGE;

/** Default Scaleway zone. Override via SCALEWAY_ZONE env var. */
export const DEFAULT_SCALEWAY_ZONE = 'fr-par-1';

/** Default Scaleway image name for label-based lookup. Override via SCALEWAY_IMAGE_NAME env var. */
export const DEFAULT_SCALEWAY_IMAGE_NAME = 'ubuntu_noble';

/** Default GCP zone. Override via GCP_DEFAULT_ZONE env var. */
export const DEFAULT_GCP_ZONE = 'us-central1-a';

/** Default GCP image family. Override via GCP_IMAGE_FAMILY env var. */
export const DEFAULT_GCP_IMAGE_FAMILY = 'ubuntu-2404-lts-amd64';

/** Default GCP image project. Override via GCP_IMAGE_PROJECT env var. */
export const DEFAULT_GCP_IMAGE_PROJECT = 'ubuntu-os-cloud';

/** Default GCP disk size in GB. Override via GCP_DISK_SIZE_GB env var. */
export const DEFAULT_GCP_DISK_SIZE_GB = 50;

/** Default GCP WIF pool ID. Override via GCP_WIF_POOL_ID env var. */
export const DEFAULT_GCP_WIF_POOL_ID = 'sam-pool';

/** Default GCP WIF provider ID. Override via GCP_WIF_PROVIDER_ID env var. */
export const DEFAULT_GCP_WIF_PROVIDER_ID = 'sam-oidc';

/** Default GCP service account ID. Override via GCP_SERVICE_ACCOUNT_ID env var. */
export const DEFAULT_GCP_SERVICE_ACCOUNT_ID = 'sam-vm-manager';

/** Default GCP STS token cache TTL in seconds (55 minutes). Override via GCP_TOKEN_CACHE_TTL_SECONDS env var. */
export const DEFAULT_GCP_TOKEN_CACHE_TTL_SECONDS = 55 * 60;

/** Default GCP identity token expiry in seconds (10 minutes). Override via GCP_IDENTITY_TOKEN_EXPIRY_SECONDS env var. */
export const DEFAULT_GCP_IDENTITY_TOKEN_EXPIRY_SECONDS = 600;

/** Default GCP operation poll timeout in ms (5 minutes). Override via GCP_OPERATION_POLL_TIMEOUT_MS env var. */
export const DEFAULT_GCP_OPERATION_POLL_TIMEOUT_MS = 5 * 60 * 1000;

/** Default GCP API timeout in ms (30 seconds). Override via GCP_API_TIMEOUT_MS env var. */
export const DEFAULT_GCP_API_TIMEOUT_MS = 30_000;

/** Default GCP SA access token lifetime in seconds (1 hour). Override via GCP_SA_TOKEN_LIFETIME_SECONDS env var. */
export const DEFAULT_GCP_SA_TOKEN_LIFETIME_SECONDS = 3600;

/** Default scope for GCP STS token exchange. Override via GCP_STS_SCOPE env var. */
export const DEFAULT_GCP_STS_SCOPE = 'https://www.googleapis.com/auth/cloud-platform';

/** Default scopes for GCP SA impersonation (comma-separated). Override via GCP_SA_IMPERSONATION_SCOPES env var. */
export const DEFAULT_GCP_SA_IMPERSONATION_SCOPES = 'https://www.googleapis.com/auth/compute';
