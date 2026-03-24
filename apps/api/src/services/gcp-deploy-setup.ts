import type { Env } from '../index';
import type { ProjectDeploymentCredential } from '@simple-agent-manager/shared';
import {
  DEFAULT_GCP_DEPLOY_WIF_POOL_ID,
  DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID,
  DEFAULT_GCP_DEPLOY_SERVICE_ACCOUNT_ID,
  DEFAULT_GCP_API_TIMEOUT_MS,
} from '@simple-agent-manager/shared';
import {
  getProjectNumber,
  enableApis,
  createWifPool,
  createOidcProvider,
  createServiceAccount,
  grantWifUserOnSa,
  grantProjectRoles,
  type SetupProgressCallback,
} from './gcp-setup';

/** APIs required for deployment (Cloud Run, Storage, Artifact Registry, Cloud Build). */
const DEPLOY_APIS = [
  'cloudresourcemanager.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'run.googleapis.com',
  'storage.googleapis.com',
  'artifactregistry.googleapis.com',
  'cloudbuild.googleapis.com',
];

/** Roles granted to the deployment service account. */
const DEPLOY_SA_PROJECT_ROLES = [
  'roles/run.admin', // Cloud Run deployment
  'roles/storage.admin', // Cloud Storage for build artifacts
  'roles/artifactregistry.admin', // Artifact Registry for container images
  'roles/iam.serviceAccountUser', // Act as service account for Cloud Run
  'roles/cloudbuild.builds.editor', // Cloud Build for building containers
];

/**
 * Run GCP deployment setup for a project.
 * Creates WIF pool, OIDC provider, and service account with deployment roles.
 */
export async function runGcpDeploySetup(
  oauthToken: string,
  gcpProjectId: string,
  env: Env,
  onProgress?: SetupProgressCallback,
): Promise<Omit<ProjectDeploymentCredential, 'id' | 'userId' | 'createdAt' | 'updatedAt'>> {
  const timeoutMs = env.GCP_API_TIMEOUT_MS
    ? parseInt(env.GCP_API_TIMEOUT_MS, 10)
    : DEFAULT_GCP_API_TIMEOUT_MS;
  const poolId = env.GCP_DEPLOY_WIF_POOL_ID || DEFAULT_GCP_DEPLOY_WIF_POOL_ID;
  const providerId = env.GCP_DEPLOY_WIF_PROVIDER_ID || DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID;
  const saAccountId = env.GCP_DEPLOY_SERVICE_ACCOUNT_ID || DEFAULT_GCP_DEPLOY_SERVICE_ACCOUNT_ID;
  const issuerUri = `https://api.${env.BASE_DOMAIN}`;

  // Step 1: Get project number
  onProgress?.('get_project_number', 'in_progress');
  const projectNumber = await getProjectNumber(oauthToken, gcpProjectId, timeoutMs);
  onProgress?.('get_project_number', 'done');

  // Step 2: Enable deployment APIs
  onProgress?.('enable_apis', 'in_progress');
  await enableApis(oauthToken, projectNumber, timeoutMs, DEPLOY_APIS);
  onProgress?.('enable_apis', 'done');

  // Step 3: Create WIF pool
  onProgress?.('create_wif_pool', 'in_progress');
  await createWifPool(oauthToken, projectNumber, poolId, timeoutMs);
  onProgress?.('create_wif_pool', 'done');

  // Step 4: Create OIDC provider
  onProgress?.('create_oidc_provider', 'in_progress');
  await createOidcProvider(oauthToken, projectNumber, poolId, providerId, issuerUri, timeoutMs);
  onProgress?.('create_oidc_provider', 'done');

  // Step 5: Create service account
  onProgress?.('create_service_account', 'in_progress');
  const saEmail = await createServiceAccount(
    oauthToken, gcpProjectId, saAccountId, timeoutMs,
    'SAM Deployer',
    'Service account for SAM deployment via Defang',
  );
  onProgress?.('create_service_account', 'done');

  // Step 6: Grant WIF user on SA
  onProgress?.('grant_wif_user', 'in_progress');
  await grantWifUserOnSa(oauthToken, gcpProjectId, projectNumber, saEmail, poolId, timeoutMs);
  onProgress?.('grant_wif_user', 'done');

  // Step 7: Grant deployment roles
  onProgress?.('grant_project_roles', 'in_progress');
  await grantProjectRoles(oauthToken, gcpProjectId, saEmail, timeoutMs, DEPLOY_SA_PROJECT_ROLES);
  onProgress?.('grant_project_roles', 'done');

  return {
    projectId: '', // Caller sets this
    provider: 'gcp',
    gcpProjectId,
    gcpProjectNumber: projectNumber,
    serviceAccountEmail: saEmail,
    wifPoolId: poolId,
    wifProviderId: providerId,
  };
}
