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
