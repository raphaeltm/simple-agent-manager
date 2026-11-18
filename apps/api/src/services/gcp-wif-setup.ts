import * as v from 'valibot';

import { readResponseJson } from '../lib/runtime-validation';
import { GcpApiError } from './gcp-errors';
import {
  fetchWithTimeout,
  gcpOperationSchema,
  iamBindingSchema,
  IAM_URL,
  pollOperation,
  requireOperationName,
} from './gcp-setup-transport';

const serviceAccountPolicySchema = v.object({
  bindings: v.optional(v.array(iamBindingSchema)),
  etag: v.string(),
});

/**
 * Validate a value is safe for interpolation into a GCP CEL attribute condition.
 * SAM project IDs are ULIDs (alphanumeric), but this guard enforces the invariant
 * at the function boundary to prevent injection if a non-ULID value is ever passed.
 */
function assertSafeCelValue(value: string, fieldName: string): void {
  if (!/^[a-zA-Z0-9_:.-]+$/.test(value)) {
    throw new Error(`${fieldName} contains characters unsafe for CEL interpolation`);
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
  timeoutMs: number
): Promise<string> {
  const url = `${IAM_URL}/projects/${projectNumber}/locations/global/workloadIdentityPools?workloadIdentityPoolId=${poolId}`;
  const res = await fetchWithTimeout(
    url,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        displayName: 'Simple Agent Manager',
        description: 'Workload identity pool for SAM platform',
      }),
    },
    timeoutMs
  );

  if (res.status === 409) {
    // Already exists — reuse
    return `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}`;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new GcpApiError({
      step: 'create_wif_pool',
      message: `Failed to create WIF pool (${res.status})`,
      statusCode: res.status,
      rawBody: body,
    });
  }

  const op = await readResponseJson(res, gcpOperationSchema, 'gcp.iam.create_wif_pool');
  if (!op.done) {
    await pollOperation(oauthToken, requireOperationName(op, 'create_wif_pool'), timeoutMs);
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
  samProjectId?: string
): Promise<void> {
  // The OIDC provider's allowedAudiences must match the JWT aud claim (https:// scheme).
  // GCP STS uses the protocol-relative format (//iam.googleapis.com/...) separately in gcp-sts.ts.
  const wifAudience = `https://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  // Enforce both issuer and SAM project ID in the attribute condition to prevent
  // cross-project impersonation within the same WIF pool.
  if (samProjectId) {
    assertSafeCelValue(samProjectId, 'samProjectId');
  }
  const attributeCondition = samProjectId
    ? `assertion.iss == '${issuerUri}' && assertion.project_id == '${samProjectId}'`
    : `assertion.iss == '${issuerUri}'`;

  const url = `${IAM_URL}/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers?workloadIdentityPoolProviderId=${providerId}`;
  const res = await fetchWithTimeout(
    url,
    {
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
        attributeCondition,
        oidc: {
          issuerUri,
          allowedAudiences: [wifAudience],
        },
      }),
    },
    timeoutMs
  );

  if (res.status === 409) {
    // Already exists — update instead
    await updateOidcProvider(
      oauthToken,
      projectNumber,
      poolId,
      providerId,
      issuerUri,
      timeoutMs,
      samProjectId
    );
    return;
  }

  if (!res.ok) {
    const body = await res.text();
    throw new GcpApiError({
      step: 'create_oidc_provider',
      message: `Failed to create OIDC provider (${res.status})`,
      statusCode: res.status,
      rawBody: body,
    });
  }

  const op = await readResponseJson(res, gcpOperationSchema, 'gcp.iam.create_oidc_provider');
  if (!op.done) {
    await pollOperation(oauthToken, requireOperationName(op, 'create_oidc_provider'), timeoutMs);
  }
}

/** A setup retry may update its own provider, never a different installation's trust. */
async function requireOidcProviderIssuer(
  oauthToken: string,
  name: string,
  issuerUri: string,
  timeoutMs: number
): Promise<void> {
  const res = await fetchWithTimeout(
    `${IAM_URL}/${name}`,
    { headers: { Authorization: `Bearer ${oauthToken}` } },
    timeoutMs
  );
  if (!res.ok) {
    throw new GcpApiError({
      step: 'update_oidc_provider',
      message: `Failed to read existing OIDC provider (${res.status})`,
      statusCode: res.status,
      rawBody: await res.text(),
    });
  }
  const current = await readResponseJson(
    res,
    v.object({ name: v.string(), oidc: v.object({ issuerUri: v.string() }) }),
    'gcp.iam.existing_oidc_provider'
  );
  if (current.name !== name || current.oidc.issuerUri !== issuerUri) {
    throw new GcpApiError({
      step: 'oidc_provider_issuer_mismatch',
      statusCode: 409,
      message: 'Existing workload identity provider belongs to a different SAM installation',
    });
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
  samProjectId?: string
): Promise<void> {
  const wifAudience = `https://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  if (samProjectId) {
    assertSafeCelValue(samProjectId, 'samProjectId');
  }
  const attributeCondition = samProjectId
    ? `assertion.iss == '${issuerUri}' && assertion.project_id == '${samProjectId}'`
    : `assertion.iss == '${issuerUri}'`;

  const name = `projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;
  await requireOidcProviderIssuer(oauthToken, name, issuerUri, timeoutMs);
  const url = `${IAM_URL}/${name}?updateMask=attributeMapping,attributeCondition,oidc`;
  const res = await fetchWithTimeout(
    url,
    {
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
        attributeCondition,
        oidc: {
          issuerUri,
          allowedAudiences: [wifAudience],
        },
      }),
    },
    timeoutMs
  );

  if (!res.ok) {
    const body = await res.text();
    throw new GcpApiError({
      step: 'update_oidc_provider',
      message: `Failed to update OIDC provider (${res.status})`,
      statusCode: res.status,
      rawBody: body,
    });
  }

  const op = await readResponseJson(res, gcpOperationSchema, 'gcp.iam.update_oidc_provider');
  if (!op.done) {
    await pollOperation(oauthToken, requireOperationName(op, 'update_oidc_provider'), timeoutMs);
  }
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
  samProjectId?: string
): Promise<void> {
  // Validate early, before any network calls (fail-fast pattern).
  if (samProjectId) {
    assertSafeCelValue(samProjectId, 'samProjectId');
  }

  const saResource = `projects/${projectId}/serviceAccounts/${saEmail}`;

  // Read current policy
  const getUrl = `${IAM_URL}/${saResource}:getIamPolicy`;
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
      step: 'grant_wif_user',
      message: `Failed to get SA IAM policy (${getRes.status})`,
      statusCode: getRes.status,
      rawBody: body,
    });
  }

  const policy = await readResponseJson(
    getRes,
    serviceAccountPolicySchema,
    'gcp.iam.service_account_policy'
  );

  // Use subject-scoped principal to prevent cross-project impersonation.
  // The `sub` claim in the identity token is `project:${samProjectId}`, so the principal
  // matches only tokens issued for this specific SAM project.
  const member = samProjectId
    ? `principal://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/subject/project:${samProjectId}`
    : `principalSet://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/*`;
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
  const setRes = await fetchWithTimeout(
    setUrl,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${oauthToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ policy: { bindings, etag: policy.etag } }),
    },
    timeoutMs
  );

  if (!setRes.ok) {
    const body = await setRes.text();
    throw new GcpApiError({
      step: 'grant_wif_user',
      message: `Failed to set SA IAM policy (${setRes.status})`,
      statusCode: setRes.status,
      rawBody: body,
    });
  }
}
