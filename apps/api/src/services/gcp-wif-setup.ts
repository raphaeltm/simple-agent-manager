import * as v from 'valibot';

import { readResponseJson } from '../lib/runtime-validation';
import { GcpApiError } from './gcp-errors';
import {
  fetchWithTimeout,
  gcpOperationSchema,
  IAM_URL,
  iamBindingSchema,
  pollOperation,
  requireOperationName,
} from './gcp-setup-transport';

// Loose, so a binding's IAM `condition` and the policy `version` survive the read-modify-write.
const serviceAccountBindingSchema = v.looseObject({
  ...iamBindingSchema.entries,
  condition: v.optional(v.unknown()),
});
const serviceAccountPolicySchema = v.looseObject({
  bindings: v.optional(v.array(serviceAccountBindingSchema)),
  etag: v.string(),
  version: v.optional(v.number()),
});

/**
 * Validate a value is safe for interpolation into a GCP CEL attribute condition or an IAM
 * principal path. SAM project and user IDs are alphanumeric, but this guard enforces the
 * invariant at the function boundary to prevent injection if another value is ever passed.
 */
function assertSafeCelValue(value: string, fieldName: string): void {
  if (typeof value !== 'string' || !/^[a-zA-Z0-9_:.-]+$/.test(value)) {
    throw new Error(`${fieldName} contains characters unsafe for CEL interpolation`);
  }
}

/**
 * Whose tokens a workload identity provider and its service-account binding accept.
 * - `project`: one SAM project (deployment setup). Tokens carry `project_id` and
 *   `sub = project:<id>`.
 * - `user`: one SAM user (user-level guided setup). Tokens carry `user_id`, mapped to
 *   `attribute.sam_user`.
 * There is no issuer-only scope: a provider that checks only SAM's issuer accepts a token SAM
 * signs for any user, so any user could name the pool and impersonate its service account.
 */
export type WifTrustScope =
  { kind: 'project'; samProjectId: string } | { kind: 'user'; userId: string };

function assertSafeTrustScope(scope: WifTrustScope): void {
  if (scope.kind === 'project') assertSafeCelValue(scope.samProjectId, 'samProjectId');
  else assertSafeCelValue(scope.userId, 'userId');
}

/** The provider's attribute condition: SAM's issuer plus the scope's own claim. */
export function wifAttributeCondition(issuerUri: string, scope: WifTrustScope): string {
  assertSafeTrustScope(scope);
  return scope.kind === 'project'
    ? `assertion.iss == '${issuerUri}' && assertion.project_id == '${scope.samProjectId}'`
    : `assertion.iss == '${issuerUri}' && assertion.user_id == '${scope.userId}'`;
}

function poolPrincipalPrefix(projectNumber: string, poolId: string): string {
  return `iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}`;
}

/** The service-account binding member that admits exactly the scope's tokens. */
export function wifServiceAccountMember(
  projectNumber: string,
  poolId: string,
  scope: WifTrustScope
): string {
  assertSafeTrustScope(scope);
  const pool = poolPrincipalPrefix(projectNumber, poolId);
  // A project token's `sub` is `project:<samProjectId>`; a user token's `user_id` is mapped
  // to `attribute.sam_user`.
  return scope.kind === 'project'
    ? `principal://${pool}/subject/project:${scope.samProjectId}`
    : `principalSet://${pool}/attribute.sam_user/${scope.userId}`;
}

/** The pool-wide member earlier user-level setups granted. Re-running setup removes it. */
export function legacyPoolWideMember(projectNumber: string, poolId: string): string {
  return `principalSet://${poolPrincipalPrefix(projectNumber, poolId)}/*`;
}

/** Google allows 4-32 characters of [a-z0-9-] for a provider ID and reserves the "gcp-" prefix. */
const WIF_PROVIDER_ID_MAX_LENGTH = 32;
const WIF_PROVIDER_ID_PREFIX = 'sam-';
const WIF_PROVIDER_ID_HASH_LENGTH = 6;

/**
 * Workload identity provider ID for one SAM installation.
 *
 * A provider trusts exactly one issuer, so installations that share a Google Cloud
 * project need distinct providers. The ID is a readable slug of the installation's
 * base domain plus a hash of it, so two domains that slug alike still differ:
 * `sammy2.party` → `sam-sammy2-party-<hash>`. Saved credentials keep the IDs they
 * were created with; this only names providers created by a new setup run.
 */
export async function installationWifProviderId(baseDomain: string): Promise<string> {
  const normalized = baseDomain.trim().toLowerCase();
  if (!normalized) {
    throw new Error('BASE_DOMAIN is required to name the workload identity provider');
  }
  const digest = new Uint8Array(
    await crypto.subtle.digest('SHA-256', new TextEncoder().encode(normalized))
  );
  const hash = Array.from(digest, (byte) => byte.toString(16).padStart(2, '0'))
    .join('')
    .slice(0, WIF_PROVIDER_ID_HASH_LENGTH);
  const slugBudget =
    WIF_PROVIDER_ID_MAX_LENGTH - WIF_PROVIDER_ID_PREFIX.length - 1 - WIF_PROVIDER_ID_HASH_LENGTH;
  const slug = normalized
    .replace(/[^a-z0-9]+/g, '-')
    .slice(0, slugBudget)
    // Normalization collapses each separator run to one hyphen.
    .replace(/^-|-$/g, '');
  return slug ? `${WIF_PROVIDER_ID_PREFIX}${slug}-${hash}` : `${WIF_PROVIDER_ID_PREFIX}${hash}`;
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
  scope: WifTrustScope
): Promise<void> {
  // The OIDC provider's allowedAudiences must match the JWT aud claim (https:// scheme).
  // GCP STS uses the protocol-relative format (//iam.googleapis.com/...) separately in gcp-sts.ts.
  const wifAudience = `https://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  // Issuer plus the scope's own claim, so a token SAM signs for anyone else is refused.
  const attributeCondition = wifAttributeCondition(issuerUri, scope);

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
      scope
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
  scope: WifTrustScope
): Promise<void> {
  const wifAudience = `https://iam.googleapis.com/projects/${projectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  // Re-running setup rewrites an existing provider's condition, so a provider created by an
  // earlier issuer-only setup is narrowed to the scope here.
  const attributeCondition = wifAttributeCondition(issuerUri, scope);

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
  scope: WifTrustScope
): Promise<void> {
  // Validate early, before any network calls (fail-fast pattern).
  const member = wifServiceAccountMember(projectNumber, poolId, scope);
  const legacyMember = legacyPoolWideMember(projectNumber, poolId);

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
      // Version 3 returns conditional bindings under their real role with a `condition` field.
      // Without it Google appends `_withcond_<hash>` to the role, and a conditional `pool/*`
      // grant would escape the removal below.
      body: JSON.stringify({ options: { requestedPolicyVersion: 3 } }),
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

  const role = 'roles/iam.workloadIdentityUser';

  // Grant the scoped member and drop the pool-wide member an earlier user-level setup granted:
  // while `pool/*` stays, any provider in the pool that still trusts SAM's issuer alone lets
  // every SAM user impersonate this service account.
  const roleBindings = (policy.bindings || []).filter((b) => b.role === role);
  // Only an unconditional grant counts: a member under someone's IAM condition may be denied.
  const granted = roleBindings.some((b) => b.condition === undefined && b.members.includes(member));
  const legacyPresent = roleBindings.some((b) => b.members.includes(legacyMember));
  if (granted && !legacyPresent) {
    return; // Already granted, nothing to remove
  }

  const bindings = (policy.bindings || []).map((b) =>
    b.role === role ? { ...b, members: b.members.filter((m) => m !== legacyMember) } : b
  );
  if (!granted) {
    // Never add the member under another binding's IAM condition.
    const target = bindings.find((b) => b.role === role && b.condition === undefined);
    if (target) target.members.push(member);
    else bindings.push({ role, members: [member] });
  }
  // A binding left with no members after removing `pool/*` is dropped rather than sent empty.
  const nonEmptyBindings = bindings.filter((b) => b.members.length > 0);

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
      body: JSON.stringify({
        policy: {
          bindings: nonEmptyBindings,
          etag: policy.etag,
          // Conditional bindings can only be written back in a version 3 policy.
          ...(nonEmptyBindings.some((b) => b.condition !== undefined)
            ? { version: 3 }
            : policy.version !== undefined
              ? { version: policy.version }
              : {}),
        },
      }),
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
