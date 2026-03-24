import type { Env } from '../index';
import type { GcpOidcCredential } from '@simple-agent-manager/shared';
import {
  DEFAULT_GCP_WIF_POOL_ID,
  DEFAULT_GCP_WIF_PROVIDER_ID,
  DEFAULT_GCP_SERVICE_ACCOUNT_ID,
  DEFAULT_GCP_API_TIMEOUT_MS,
} from '@simple-agent-manager/shared';

const RESOURCE_MANAGER_URL = 'https://cloudresourcemanager.googleapis.com/v1';
const SERVICE_USAGE_URL = 'https://serviceusage.googleapis.com/v1';
const IAM_URL = 'https://iam.googleapis.com/v1';

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

/** Status callback for setup progress reporting */
export type SetupProgressCallback = (step: string, status: 'pending' | 'in_progress' | 'done' | 'error') => void;

/**
 * List the user's GCP projects using their OAuth access token.
 */
export async function listGcpProjects(
  oauthToken: string,
  timeoutMs: number,
): Promise<Array<{ projectId: string; name: string; projectNumber: string }>> {
  const projects: Array<{ projectId: string; name: string; projectNumber: string }> = [];
  let pageToken: string | undefined;

  do {
    const url = `${RESOURCE_MANAGER_URL}/projects?filter=lifecycleState:ACTIVE${pageToken ? `&pageToken=${pageToken}` : ''}`;
    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${oauthToken}` },
    }, timeoutMs);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to list GCP projects (${res.status}): ${body}`);
    }

    const data = (await res.json()) as GcpProjectListResponse;
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
  timeoutMs: number,
): Promise<string> {
  const url = `${RESOURCE_MANAGER_URL}/projects/${projectId}`;
  const res = await fetchWithTimeout(url, {
    headers: { Authorization: `Bearer ${oauthToken}` },
  }, timeoutMs);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to get project ${projectId} (${res.status}): ${body}`);
  }

  const data = (await res.json()) as GcpProject;
  return data.projectNumber;
}

/**
 * Enable required GCP APIs for the project.
 */
/** Default APIs enabled for VM provisioning. */
const VM_APIS = [
  'cloudresourcemanager.googleapis.com',
  'iam.googleapis.com',
  'iamcredentials.googleapis.com',
  'sts.googleapis.com',
  'compute.googleapis.com',
  'aiplatform.googleapis.com',
];

export async function enableApis(
  oauthToken: string,
  projectNumber: string,
  timeoutMs: number,
  serviceIds: string[] = VM_APIS,
): Promise<void> {
  const url = `${SERVICE_USAGE_URL}/projects/${projectNumber}/services:batchEnable`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ serviceIds }),
  }, timeoutMs);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to enable APIs (${res.status}): ${body}`);
  }

  // Poll the long-running operation
  const op = (await res.json()) as { name: string; done?: boolean };
  if (!op.done) {
    await pollOperation(oauthToken, op.name, timeoutMs);
  }
}

/**
 * Create a Workload Identity Pool.
 * Returns the pool name or reuses an existing one if it already exists.
 */
export async function createWifPool(
  oauthToken: string,
  projectNumber: string,
  poolId: string,
  timeoutMs: number,
): Promise<string> {
  const url = `${IAM_URL}/projects/${projectNumber}/locations/global/workloadIdentityPools?workloadIdentityPoolId=${poolId}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      displayName: 'Simple Agent Manager',
      description: 'Workload identity pool for SAM platform',
    }),
  }, timeoutMs);

  if (res.status === 409) {
    // Already exists — reuse
    return `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}`;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create WIF pool (${res.status}): ${body}`);
  }

  const op = (await res.json()) as { name: string; done?: boolean };
  if (!op.done) {
    await pollOperation(oauthToken, op.name, timeoutMs);
  }

  return `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}`;
}

/**
 * Create an OIDC provider in the WIF pool.
 */
export async function createOidcProvider(
  oauthToken: string,
  projectNumber: string,
  poolId: string,
  providerId: string,
  issuerUri: string,
  timeoutMs: number,
): Promise<void> {
  // The OIDC provider's allowedAudiences must match the JWT aud claim (https:// scheme).
  // GCP STS uses the protocol-relative format (//iam.googleapis.com/...) separately in gcp-sts.ts.
  const wifAudience = `https://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  const url = `${IAM_URL}/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers?workloadIdentityPoolProviderId=${providerId}`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      displayName: 'SAM OIDC Provider',
      description: 'OIDC provider for Simple Agent Manager',
      attributeMapping: {
        'google.subject': 'assertion.sub',
        'attribute.sam_user': 'assertion.user_id',
        'attribute.sam_project': 'assertion.project_id',
      },
      attributeCondition: `assertion.iss == '${issuerUri}'`,
      oidc: {
        issuerUri,
        allowedAudiences: [wifAudience],
      },
    }),
  }, timeoutMs);

  if (res.status === 409) {
    // Already exists — update instead
    await updateOidcProvider(oauthToken, projectNumber, poolId, providerId, issuerUri, timeoutMs);
    return;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create OIDC provider (${res.status}): ${body}`);
  }

  const op = (await res.json()) as { name: string; done?: boolean };
  if (!op.done) {
    await pollOperation(oauthToken, op.name, timeoutMs);
  }
}

/**
 * Update an existing OIDC provider (if it already existed).
 */
export async function updateOidcProvider(
  oauthToken: string,
  projectNumber: string,
  poolId: string,
  providerId: string,
  issuerUri: string,
  timeoutMs: number,
): Promise<void> {
  const wifAudience = `https://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  const name = `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
  const url = `${IAM_URL}/${name}?updateMask=attributeMapping,attributeCondition,oidc`;
  const res = await fetchWithTimeout(url, {
    method: 'PATCH',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      attributeMapping: {
        'google.subject': 'assertion.sub',
        'attribute.sam_user': 'assertion.user_id',
        'attribute.sam_project': 'assertion.project_id',
      },
      attributeCondition: `assertion.iss == '${issuerUri}'`,
      oidc: {
        issuerUri,
        allowedAudiences: [wifAudience],
      },
    }),
  }, timeoutMs);

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to update OIDC provider (${res.status}): ${body}`);
  }

  const op = (await res.json()) as { name: string; done?: boolean };
  if (!op.done) {
    await pollOperation(oauthToken, op.name, timeoutMs);
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
  description = 'Service account for SAM to manage Compute Engine VMs',
): Promise<string> {
  const url = `${IAM_URL}/projects/${projectId}/serviceAccounts`;
  const res = await fetchWithTimeout(url, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      accountId,
      serviceAccount: { displayName, description },
    }),
  }, timeoutMs);

  const email = `${accountId}@${projectId}.iam.gserviceaccount.com`;

  if (res.status === 409) {
    // Already exists — reuse
    return email;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Failed to create service account (${res.status}): ${body}`);
  }

  return email;
}

/**
 * Grant Workload Identity User on the service account (read-modify-write pattern).
 */
export async function grantWifUserOnSa(
  oauthToken: string,
  projectId: string,
  projectNumber: string,
  saEmail: string,
  poolId: string,
  timeoutMs: number,
): Promise<void> {
  const saResource = `projects/${projectId}/serviceAccounts/${saEmail}`;

  // Read current policy
  const getUrl = `${IAM_URL}/${saResource}:getIamPolicy`;
  const getRes = await fetchWithTimeout(getUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  }, timeoutMs);

  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`Failed to get SA IAM policy (${getRes.status}): ${body}`);
  }

  const policy = (await getRes.json()) as {
    bindings?: Array<{ role: string; members: string[] }>;
    etag: string;
  };

  const member = `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/*`;
  const role = 'roles/iam.workloadIdentityUser';

  // Check if binding already exists
  const existingBinding = (policy.bindings || []).find((b) => b.role === role);
  if (existingBinding?.members?.includes(member)) {
    return; // Already granted
  }

  // Add our binding
  const bindings = [...(policy.bindings || [])];
  if (existingBinding) {
    existingBinding.members.push(member);
  } else {
    bindings.push({ role, members: [member] });
  }

  // Write updated policy
  const setUrl = `${IAM_URL}/${saResource}:setIamPolicy`;
  const setRes = await fetchWithTimeout(setUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ policy: { bindings, etag: policy.etag } }),
  }, timeoutMs);

  if (!setRes.ok) {
    const body = await setRes.text();
    throw new Error(`Failed to set SA IAM policy (${setRes.status}): ${body}`);
  }
}

/**
 * Grant Compute Instance Admin to the service account on the project (read-modify-write).
 */
/** Roles granted to the SAM service account on the user's GCP project. */
const SA_PROJECT_ROLES = [
  'roles/compute.instanceAdmin.v1', // VM lifecycle management
  'roles/compute.securityAdmin',    // Firewall rule management (not included in instanceAdmin)
  'roles/aiplatform.user',          // Vertex AI access (e.g. Gemini CLI)
];

export async function grantProjectRoles(
  oauthToken: string,
  projectId: string,
  saEmail: string,
  timeoutMs: number,
  roles: string[] = SA_PROJECT_ROLES,
): Promise<void> {
  // Read current project IAM policy
  const getUrl = `${RESOURCE_MANAGER_URL}/projects/${projectId}:getIamPolicy`;
  const getRes = await fetchWithTimeout(getUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: '{}',
  }, timeoutMs);

  if (!getRes.ok) {
    const body = await getRes.text();
    throw new Error(`Failed to get project IAM policy (${getRes.status}): ${body}`);
  }

  const policy = (await getRes.json()) as {
    bindings?: Array<{ role: string; members: string[] }>;
    etag: string;
    version?: number;
  };

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
  const setRes = await fetchWithTimeout(setUrl, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${oauthToken}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      policy: { bindings, etag: policy.etag, version: 3 },
    }),
  }, timeoutMs);

  if (!setRes.ok) {
    const body = await setRes.text();
    throw new Error(`Failed to set project IAM policy (${setRes.status}): ${body}`);
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
  await createOidcProvider(oauthToken, projectNumber, poolId, providerId, issuerUri, timeoutMs);
  onProgress?.('create_oidc_provider', 'done');

  // Step 5: Create service account
  onProgress?.('create_service_account', 'in_progress');
  const saEmail = await createServiceAccount(oauthToken, gcpProjectId, saAccountId, timeoutMs);
  onProgress?.('create_service_account', 'done');

  // Step 6: Grant WIF user on SA
  onProgress?.('grant_wif_user', 'in_progress');
  await grantWifUserOnSa(oauthToken, gcpProjectId, projectNumber, saEmail, poolId, timeoutMs);
  onProgress?.('grant_wif_user', 'done');

  // Step 7: Grant project roles (compute admin + Vertex AI)
  onProgress?.('grant_project_roles', 'in_progress');
  await grantProjectRoles(oauthToken, gcpProjectId, saEmail, timeoutMs);
  onProgress?.('grant_project_roles', 'done');

  return {
    provider: 'gcp',
    gcpProjectId,
    gcpProjectNumber: projectNumber,
    serviceAccountEmail: saEmail,
    wifPoolId: poolId,
    wifProviderId: providerId,
    defaultZone,
  };
}

/**
 * Poll a GCP long-running operation until complete.
 */
export async function pollOperation(
  oauthToken: string,
  operationName: string,
  timeoutMs: number,
): Promise<void> {
  const deadline = Date.now() + 5 * 60 * 1000; // 5 min max
  let delayMs = 2000;

  while (Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, delayMs));

    // Some operations use different base URLs depending on the API
    let url: string;
    if (operationName.startsWith('operations/')) {
      url = `${SERVICE_USAGE_URL}/${operationName}`;
    } else {
      url = `${IAM_URL}/${operationName}`;
    }

    const res = await fetchWithTimeout(url, {
      headers: { Authorization: `Bearer ${oauthToken}` },
    }, timeoutMs);

    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Failed to poll operation ${operationName} (${res.status}): ${body}`);
    }

    const op = (await res.json()) as { done?: boolean; error?: { message: string } };
    if (op.error) {
      throw new Error(`GCP operation failed: ${op.error.message}`);
    }
    if (op.done) {
      return;
    }

    delayMs = Math.min(delayMs * 1.5, 10_000);
  }

  throw new Error(`GCP operation timed out: ${operationName}`);
}

export async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}
