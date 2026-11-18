import type { GcpOidcCredential } from '@simple-agent-manager/shared';
import {
  DEFAULT_GCP_API_TIMEOUT_MS,
  DEFAULT_GCP_SERVICE_ACCOUNT_ID,
  DEFAULT_GCP_WIF_POOL_ID,
  DEFAULT_GCP_WIF_PROVIDER_ID,
  GCP_CREDENTIAL_VERSION,
  GCP_REQUIRED_APIS,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../env';
import { readResponseJson } from '../lib/runtime-validation';
import { GcpApiError } from './gcp-errors';
import {
  fetchWithTimeout,
  gcpOperationSchema,
  IAM_URL,
  iamBindingSchema,
  pollOperation,
  requireOperationName,
  SERVICE_USAGE_URL,
} from './gcp-setup-transport';
import { createOidcProvider, createWifPool, grantWifUserOnSa } from './gcp-wif-setup';
export { fetchWithTimeout, pollOperation } from './gcp-setup-transport';
export {
  createOidcProvider,
  createWifPool,
  grantWifUserOnSa,
  updateOidcProvider,
} from './gcp-wif-setup';

const RESOURCE_MANAGER_URL = 'https://cloudresourcemanager.googleapis.com/v1';

interface GcpProject {
  projectId: string;
  projectNumber: string;
  name: string;
  lifecycleState: string;
}

interface GcpProjectListResponse {
  projects?: GcpProject[];
  nextPageToken?: string;
}

const gcpProjectSchema = v.object({
  projectId: v.string(),
  projectNumber: v.string(),
  name: v.string(),
  lifecycleState: v.string(),
});

const gcpProjectNumberResponseSchema = v.object({
  projectNumber: v.string(),
});

const gcpProjectListResponseSchema = v.object({
  projects: v.optional(v.array(gcpProjectSchema)),
  nextPageToken: v.optional(v.string()),
});

const projectPolicySchema = v.object({
  bindings: v.optional(v.array(iamBindingSchema)),
  etag: v.string(),
  version: v.optional(v.number()),
});

/** Status callback for setup progress reporting */
export type SetupProgressCallback = (
  step: string,
  status: 'pending' | 'in_progress' | 'done' | 'error'
) => void;

/**
 * List the user's GCP projects using their OAuth access token.
 */
export async function listGcpProjects(
  oauthToken: string,
  timeoutMs: number
): Promise<Array<{ projectId: string; name: string; projectNumber: string }>> {
  const projects: Array<{ projectId: string; name: string; projectNumber: string }> = [];
  let pageToken: string | undefined;

  do {
    const url = `${RESOURCE_MANAGER_URL}/projects?filter=lifecycleState:ACTIVE${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetchWithTimeout(
      url,
      {
        headers: { Authorization: `Bearer ${oauthToken}` },
      },
      timeoutMs
    );

    if (!res.ok) {
      const body = await res.text();
      throw new GcpApiError({
        step: 'list_projects',
        message: `Failed to list GCP projects (${res.status})`,
        statusCode: res.status,
        rawBody: body,
      });
    }

    const data: GcpProjectListResponse = await readResponseJson(
      res,
      gcpProjectListResponseSchema,
      'gcp.resource_manager.list_projects'
    );
    if (data.projects) {
      for (const p of data.projects) {
        projects.push({
          projectId: p.projectId,
          name: p.name,
          projectNumber: p.projectNumber,
        });
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return projects;
}

/**
 * Get the project number for a given project ID.
 */
export async function getProjectNumber(
  oauthToken: string,
  projectId: string,
  timeoutMs: number
): Promise<string> {
  const url = `${RESOURCE_MANAGER_URL}/projects/${projectId}`;
  const res = await fetchWithTimeout(
    url,
    {
      headers: { Authorization: `Bearer ${oauthToken}` },
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text();
    throw new GcpApiError({
      step: 'get_project_number',
      message: `Failed to get project info (${res.status})`,
      statusCode: res.status,
      rawBody: body,
    });
  }

  const data = await readResponseJson(
    res,
    gcpProjectNumberResponseSchema,
    'gcp.resource_manager.project'
  );
  return data.projectNumber;
}

/** APIs enabled for VM provisioning; the list lives in shared so the UI can name them. */
const VM_APIS = GCP_REQUIRED_APIS.map((api) => api.service);

/**
 * Enable required GCP APIs for the project.
 */
export async function enableApis(
  oauthToken: string,
  projectNumber: string,
  timeoutMs: number,
  serviceIds: string[] = VM_APIS
): Promise<void> {
  const url = `${SERVICE_USAGE_URL}/projects/${projectNumber}/services:batchEnable`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ serviceIds }),
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text();
    throw new GcpApiError({
      step: 'enable_apis',
      message: `Failed to enable APIs (${res.status})`,
      statusCode: res.status,
      rawBody: body,
    });
  }

  // Poll the long-running operation
  const op = await readResponseJson(res, gcpOperationSchema, 'gcp.service_usage.batch_enable');
  // A completed operation can still have failed; recording the APIs as enabled would hide them.
  if (op.error) {
    throw new GcpApiError({
      step: 'enable_apis',
      message: 'Failed to enable APIs',
      rawBody: op.error.message,
    });
  }
  if (!op.done) {
    await pollOperation(oauthToken, requireOperationName(op, 'enable_apis'), timeoutMs);
  }
}

/**
 * Create a service account for VM management.
 */
export async function createServiceAccount(
  oauthToken: string,
  projectId: string,
  accountId: string,
  timeoutMs: number,
  displayName = 'SAM VM Manager',
  description = 'Service account for SAM to manage Compute Engine VMs'
): Promise<string> {
  const url = `${IAM_URL}/projects/${projectId}/serviceAccounts`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        accountId,
        serviceAccount: { displayName, description },
      }),
    },
    timeoutMs
  );

  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;

  if (res.status === 409) {
    // Already exists — reuse
    return email;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new GcpApiError({
      step: 'create_service_account',
      message: `Failed to create service account (${res.status})`,
      statusCode: res.status,
      rawBody: body,
    });
  }

  return email;
}

/**
 * Grant Compute Instance Admin to the service account on the project (read-modify-write).
 */
/** Roles granted to the SAM service account on the user's GCP project. */
const SA_PROJECT_ROLES = [
  'roles/compute.instanceAdmin.v1', // VM lifecycle management
  'roles/compute.securityAdmin', // Firewall rule management (not included in instanceAdmin)
  'roles/aiplatform.user', // Vertex AI access (e.g. Gemini CLI)
];

export async function grantProjectRoles(
  oauthToken: string,
  projectId: string,
  saEmail: string,
  timeoutMs: number,
  roles: string[] = SA_PROJECT_ROLES
): Promise<void> {
  // Read current project IAM policy
  const getUrl = `${RESOURCE_MANAGER_URL}/projects/${projectId}:getIamPolicy`;
  const getRes = await fetchWithTimeout(
    getUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
      },
      body: '{}',
    },
    timeoutMs
  );

  if (!getRes.ok) {
    const body = await getRes.text();
    throw new GcpApiError({
      step: 'grant_project_roles',
      message: `Failed to get project IAM policy (${getRes.status})`,
      statusCode: getRes.status,
      rawBody: body,
    });
  }

  const policy = await readResponseJson(getRes, projectPolicySchema, 'gcp.resource_manager.policy');

  const member = `serviceAccount:${saEmail}`;
  const bindings = [...(policy.bindings || [])];
  let changed = false;

  for (const role of roles) {
    const existingBinding = bindings.find((b) => b.role === role);
    if (existingBinding?.members?.includes(member)) {
      continue; // Already granted
    }
    if (existingBinding) {
      existingBinding.members.push(member);
    } else {
      bindings.push({ role, members: [member] });
    }
    changed = true;
  }

  if (!changed) {
    return; // All roles already granted
  }

  // Write updated policy with version 3 for conditional bindings support
  const setUrl = `${RESOURCE_MANAGER_URL}/projects/${projectId}:setIamPolicy`;
  const setRes = await fetchWithTimeout(
    setUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        policy: { bindings, etag: policy.etag, version: 3 },
      }),
    },
    timeoutMs
  );

  if (!setRes.ok) {
    const body = await setRes.text();
    throw new GcpApiError({
      step: 'grant_project_roles',
      message: `Failed to set project IAM policy (${setRes.status})`,
      statusCode: setRes.status,
      rawBody: body,
    });
  }
}

/**
 * Full GCP OIDC setup orchestrator.
 * Takes a Google OAuth access token and project ID, then configures all GCP resources.
 */
export async function runGcpSetup(
  oauthToken: string,
  gcpProjectId: string,
  defaultZone: string,
  env: Env,
  onProgress?: SetupProgressCallback,
  samProjectId?: string
): Promise<GcpOidcCredential> {
  const timeoutMs = env.GCP_API_TIMEOUT_MS
    ? parseInt(env.GCP_API_TIMEOUT_MS, 10)
    : DEFAULT_GCP_API_TIMEOUT_MS;
  const poolId = env.GCP_WIF_POOL_ID || DEFAULT_GCP_WIF_POOL_ID;
  const providerId = env.GCP_WIF_PROVIDER_ID || DEFAULT_GCP_WIF_PROVIDER_ID;
  const saAccountId = env.GCP_SERVICE_ACCOUNT_ID || DEFAULT_GCP_SERVICE_ACCOUNT_ID;
  const issuerUri = `https://api.${env.BASE_DOMAIN}`;

  // Step 1: Get project number
  onProgress?.('get_project_number', 'in_progress');
  const projectNumber = await getProjectNumber(oauthToken, gcpProjectId, timeoutMs);
  onProgress?.('get_project_number', 'done');

  // Step 2: Enable APIs
  onProgress?.('enable_apis', 'in_progress');
  await enableApis(oauthToken, projectNumber, timeoutMs);
  onProgress?.('enable_apis', 'done');

  // Step 3: Create WIF pool
  onProgress?.('create_wif_pool', 'in_progress');
  await createWifPool(oauthToken, projectNumber, poolId, timeoutMs);
  onProgress?.('create_wif_pool', 'done');

  // Step 4: Create OIDC provider
  onProgress?.('create_oidc_provider', 'in_progress');
  await createOidcProvider(
    oauthToken,
    projectNumber,
    poolId,
    providerId,
    issuerUri,
    timeoutMs,
    samProjectId
  );
  onProgress?.('create_oidc_provider', 'done');

  // Step 5: Create service account
  onProgress?.('create_service_account', 'in_progress');
  const saEmail = await createServiceAccount(oauthToken, gcpProjectId, saAccountId, timeoutMs);
  onProgress?.('create_service_account', 'done');

  // Step 6: Grant WIF user on SA
  onProgress?.('grant_wif_user', 'in_progress');
  await grantWifUserOnSa(
    oauthToken,
    gcpProjectId,
    projectNumber,
    saEmail,
    poolId,
    timeoutMs,
    samProjectId
  );
  onProgress?.('grant_wif_user', 'done');

  // Step 7: Grant project roles (compute admin + Vertex AI)
  onProgress?.('grant_project_roles', 'in_progress');
  await grantProjectRoles(oauthToken, gcpProjectId, saEmail, timeoutMs);
  onProgress?.('grant_project_roles', 'done');

  return {
    version: GCP_CREDENTIAL_VERSION,
    provider: 'gcp',
    authType: 'workload-identity',
    gcpProjectId,
    gcpProjectNumber: projectNumber,
    serviceAccountEmail: saEmail,
    wifPoolId: poolId,
    wifProviderId: providerId,
    defaultZone,
    // Recorded so a later addition to the required list shows this credential as needing setup.
    enabledApis: [...VM_APIS],
  };
}
