// =============================================================================
// GCP Deployment (project-level OIDC for Defang)
// =============================================================================

/** Default WIF pool ID for deployment. Override via GCP_DEPLOY_WIF_POOL_ID env var. */
export const DEFAULT_GCP_DEPLOY_WIF_POOL_ID = 'sam-deploy-pool';

/** Default WIF provider ID for deployment. Override via GCP_DEPLOY_WIF_PROVIDER_ID env var. */
export const DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID = 'sam-oidc';

/** Default service account ID for deployment. Override via GCP_DEPLOY_SERVICE_ACCOUNT_ID env var. */
export const DEFAULT_GCP_DEPLOY_SERVICE_ACCOUNT_ID = 'sam-deployer';

/** Default identity token expiry for deployment (10 minutes). Override via GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS env var. */
export const DEFAULT_GCP_DEPLOY_IDENTITY_TOKEN_EXPIRY_SECONDS = 600;

/** Default GCP STS token URL. Override via GCP_STS_TOKEN_URL env var. */
export const DEFAULT_GCP_STS_TOKEN_URL = 'https://sts.googleapis.com/v1/token';

/** Fixed Google OAuth token endpoint for service-account JWT bearer exchange. */
export const DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_URL = 'https://oauth2.googleapis.com/token';

/** Fixed Compute Engine API base used for credential readiness verification. */
export const DEFAULT_GCP_COMPUTE_API_BASE_URL = 'https://compute.googleapis.com/compute/v1';

/** Maximum JWT assertion lifetime accepted by Google OAuth. */
export const DEFAULT_GCP_SERVICE_ACCOUNT_ASSERTION_LIFETIME_SECONDS = 60 * 60;

/** Safety buffer subtracted from Google's access-token expiry before KV caching. */
export const DEFAULT_GCP_SERVICE_ACCOUNT_TOKEN_EXPIRY_SKEW_SECONDS = 5 * 60;

/** Maximum uploaded service-account JSON size. Override via GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES. */
export const DEFAULT_GCP_SERVICE_ACCOUNT_JSON_MAX_BYTES = 64 * 1024;

/** Default GCP IAM Credentials base URL for SA impersonation. Override via GCP_IAM_CREDENTIALS_BASE_URL env var. */
export const DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL =
  'https://iamcredentials.googleapis.com/v1/projects/-/serviceAccounts';

/** Default OAuth state TTL in seconds (10 minutes). Override via GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS env var. */
export const DEFAULT_GCP_DEPLOY_OAUTH_STATE_TTL_SECONDS = 600;

/** Default OAuth token handle TTL in seconds (5 minutes). Override via GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS env var. */
export const DEFAULT_GCP_DEPLOY_OAUTH_TOKEN_HANDLE_TTL_SECONDS = 300;

// Note: GitHub App install URL is NOT provided as a constant.
// It must be derived from the actual GitHub App configuration at runtime.
// Format: https://github.com/apps/{app-slug}/installations/new
