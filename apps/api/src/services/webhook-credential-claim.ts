/** One expiring claim per webhook; plaintext is returned only for the winning redemption. */
import { DEFAULT_WEBHOOK_CREDENTIAL_CLAIM_TTL_SECONDS } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { buildTrustedApiUrl } from '../lib/trusted-origins';
import { ulid } from '../lib/ulid';
import { errors } from '../middleware/error';
import { projectMemberRolesWithCapability } from '../middleware/project-auth';
import type { McpTokenData } from './mcp-token';
import { createWebhookTokenMaterial } from './webhook-trigger-store';

export function webhookClaimSession(token: McpTokenData): string {
  if (token.chatSessionId) return `chat:${token.chatSessionId}`;
  if (token.agentSessionId) return `agent:${token.agentSessionId}`;
  if (token.taskId) return `task:${token.taskId}`;
  throw errors.badRequest('Webhook credential claims require a session-scoped MCP token');
}

export function prepareWebhookClaim(env: Env, token: McpTokenData) {
  if (!token.workspaceId || !token.userId) throw errors.unauthorized();
  const claimId = ulid();
  const expiresAt =
    Date.now() +
    parsePositiveInt(
      env.WEBHOOK_CREDENTIAL_CLAIM_TTL_SECONDS,
      DEFAULT_WEBHOOK_CREDENTIAL_CLAIM_TTL_SECONDS
    ) *
      1000;
  return {
    values: {
      claimId,
      claimExpiresAt: expiresAt,
      claimUserId: token.userId,
      claimWorkspaceId: token.workspaceId,
      claimSessionId: webhookClaimSession(token),
    },
    response: {
      claimUrl: buildTrustedApiUrl(env, `/mcp/webhook-claims/${claimId}`),
      expiresAt: new Date(expiresAt).toISOString(),
      endpointUrl: buildTrustedApiUrl(env, '/api/webhooks/ingest'),
      headerName: 'Authorization',
      method: 'POST',
      instructions:
        'Redeem with the existing SAM_MCP_TOKEN from this workspace/session, using an authenticated shell HTTP request piped directly to a secret store command accepting stdin. Never read the response with a model-visible fetch tool, print it, enable shell tracing, or automatically retry. Use pipefail and verify both commands succeeded. The claim expires and can be consumed only once; after a failed/unknown transfer create a fresh trigger or rotate through the UI/REST API.',
    },
  };
}

export async function redeemWebhookClaim(env: Env, claimId: string, token: McpTokenData) {
  const sessionId = webhookClaimSession(token);
  const material = await createWebhookTokenMaterial(env.ENCRYPTION_KEY);
  const roles = projectMemberRolesWithCapability('task:write');
  // One statement is the linearization point: no separate read/delete race, no
  // retrievable plaintext, and no losing request can rotate the winning token.
  const result = await env.DATABASE.prepare(
    `UPDATE webhook_trigger_configs
     SET token_hash = ?, token_last_four = ?, token_created_at = ?, updated_at = ?,
         claim_id = NULL, claim_expires_at = NULL, claim_user_id = NULL,
         claim_workspace_id = NULL, claim_session_id = NULL
     WHERE claim_id = ? AND claim_expires_at > ?
       AND claim_user_id = ? AND claim_workspace_id = ? AND claim_session_id = ?
       AND EXISTS (SELECT 1 FROM triggers t WHERE t.id = trigger_id
         AND t.project_id = ? AND t.source_type = 'webhook'
         AND t.status != 'disabled')
       AND EXISTS (SELECT 1 FROM project_members m WHERE m.project_id = ?
         AND m.user_id = ? AND m.status = 'active'
         AND m.role IN (${roles.map(() => '?').join(', ')}))`
  )
    .bind(
      material.tokenHash,
      material.tokenLastFour,
      material.createdAt,
      material.createdAt,
      claimId,
      Date.now(),
      token.userId,
      token.workspaceId,
      sessionId,
      token.projectId,
      token.projectId,
      token.userId,
      ...roles
    )
    .run();
  return result.meta.changes === 1 ? material.token : null;
}
