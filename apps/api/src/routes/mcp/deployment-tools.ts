/**
 * MCP deployment tools — get_deployment_credentials.
 *
 * Returns a GCP external_account credential config JSON for the project's
 * deployment credential. GCP client libraries use this to auto-exchange
 * tokens via SAM's identity token endpoint.
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import {
  DEFAULT_GCP_DEPLOY_WIF_POOL_ID,
  DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID,
  DEFAULT_GCP_STS_TOKEN_URL,
  DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL,
} from '@simple-agent-manager/shared';
import {
  type McpTokenData,
  type JsonRpcResponse,
  jsonRpcSuccess,
  jsonRpcError,
  INTERNAL_ERROR,
} from './_helpers';

export async function handleGetDeploymentCredentials(
  requestId: string | number | null,
  tokenData: McpTokenData,
  env: Env,
  rawMcpToken: string,
): Promise<JsonRpcResponse> {
  const db = drizzle(env.DATABASE, { schema });

  // Look up deployment credential for this project
  const rows = await db
    .select()
    .from(schema.projectDeploymentCredentials)
    .where(
      and(
        eq(schema.projectDeploymentCredentials.projectId, tokenData.projectId),
        eq(schema.projectDeploymentCredentials.provider, 'gcp'),
      ),
    )
    .limit(1);

  const cred = rows[0];
  if (!cred) {
    return jsonRpcError(
      requestId,
      INTERNAL_ERROR,
      'No GCP deployment credential configured for this project. ' +
        'Ask the project owner to connect GCP in Project Settings > Deploy to Cloud.',
    );
  }

  // Build the identity token endpoint URL
  const identityTokenUrl = `https://api.${env.BASE_DOMAIN}/api/projects/${tokenData.projectId}/deployment-identity-token`;

  // Build WIF audience URI — uses protocol-relative `//` format for the STS `audience` field.
  // NOTE: This is intentionally different from the JWT `aud` claim in the identity token endpoint
  // (project-deployment.ts), which uses `https://`. Both forms are per GCP WIF spec.
  const poolId = cred.wifPoolId || env.GCP_DEPLOY_WIF_POOL_ID || DEFAULT_GCP_DEPLOY_WIF_POOL_ID;
  const providerId = cred.wifProviderId || env.GCP_DEPLOY_WIF_PROVIDER_ID || DEFAULT_GCP_DEPLOY_WIF_PROVIDER_ID;
  const audience = `//iam.googleapis.com/projects/${cred.gcpProjectNumber}/locations/global/workloadIdentityPools/${poolId}/providers/${providerId}`;

  // Build external_account credential config.
  // GCP client libraries call credential_source.url with the MCP token to get a fresh
  // OIDC identity JWT from SAM, then exchange it at GCP STS for a temporary access token.
  const credentialConfig = {
    type: 'external_account',
    audience,
    subject_token_type: 'urn:ietf:params:oauth:token-type:jwt',
    token_url: env.GCP_STS_TOKEN_URL || DEFAULT_GCP_STS_TOKEN_URL,
    credential_source: {
      url: identityTokenUrl,
      headers: {
        Authorization: `Bearer ${rawMcpToken}`,
      },
      format: {
        type: 'json',
        subject_token_field_name: 'token',
      },
    },
    service_account_impersonation_url:
      `${env.GCP_IAM_CREDENTIALS_BASE_URL || DEFAULT_GCP_IAM_CREDENTIALS_BASE_URL}/${cred.serviceAccountEmail}:generateAccessToken`,
  };

  const instructions = [
    '1. Write the credential config JSON below to a file (e.g., /tmp/gcp-deploy-creds.json)',
    '2. Set GOOGLE_APPLICATION_CREDENTIALS=/tmp/gcp-deploy-creds.json',
    '3. GCP client libraries (gcloud, Defang, Terraform, etc.) will auto-refresh tokens via SAM',
    `4. GCP Project: ${cred.gcpProjectId}`,
    `5. Service Account: ${cred.serviceAccountEmail}`,
    '6. Available roles: Cloud Run Admin, Storage Admin, Artifact Registry Admin, IAM SA User, Cloud Build Editor',
  ];

  return jsonRpcSuccess(requestId, {
    content: [
      {
        type: 'text',
        text: JSON.stringify(
          {
            credentialConfig,
            gcpProjectId: cred.gcpProjectId,
            serviceAccountEmail: cred.serviceAccountEmail,
            instructions,
          },
          null,
          2,
        ),
      },
    ],
  });
}
