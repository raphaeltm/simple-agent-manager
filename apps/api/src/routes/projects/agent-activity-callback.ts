import { ACP_SESSION_VALID_TRANSITIONS } from '@simple-agent-manager/shared';
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { AcpSessionActivityReportSchema, jsonValidator } from '../../schemas';
import { verifyCallbackToken } from '../../services/jwt';
import {
  callbackTokenMatchesNode,
  callbackTokenMatchesWorkspace,
} from '../../services/node-callback-auth';
import { hibernateAgentSessionOnNode } from '../../services/node-agent';
import * as projectDataService from '../../services/project-data';
import { markVmAgentContainerActiveWorkEndedBestEffort } from '../../services/vm-agent-container';

/**
 * Agent activity callback route — mounted BEFORE projectsRoutes in index.ts
 * to avoid the blanket requireAuth() middleware that validates browser session
 * cookies (not callback JWTs).
 *
 * Auth: Callback JWT via Bearer token, verified inline with verifyCallbackToken().
 * Accepts workspace-scoped tokens (the VM agent's callback token).
 *
 * The VM agent calls this endpoint from session_host_reporting.go:reportActivity()
 * to signal "prompting" / "idle" / "error" transitions. The callback
 * persists a durable activity mirror, and terminal error activity also reconciles
 * ACP/chat/agent-session state so failed startup is visible even before a prompt.
 *
 * See: .claude/rules/06-api-patterns.md (Hono middleware scoping)
 * See: .claude/rules/34-vm-agent-callback-auth.md
 */
const agentActivityCallbackRoute = new Hono<{ Bindings: Env }>();

const MAX_AGENT_ERROR_MESSAGE_LENGTH = 2048;

function truncateAgentErrorMessage(value: string): string {
  if (value.length <= MAX_AGENT_ERROR_MESSAGE_LENGTH) return value;
  return `${value.slice(0, MAX_AGENT_ERROR_MESSAGE_LENGTH - 3)}...`;
}

function normalizeAgentErrorMessage(statusError: string | null | undefined): string {
  const detail = truncateAgentErrorMessage(
    statusError?.trim() || 'Agent reported an error before producing a response'
  );
  if (/^agent (startup )?failed/i.test(detail)) return detail;
  return `Agent failed: ${detail}`;
}

function canTransitionAcpSessionToFailed(status: string): boolean {
  const validTargets = (ACP_SESSION_VALID_TRANSITIONS as Record<string, readonly string[]>)[status];
  return validTargets?.includes('failed') ?? false;
}

agentActivityCallbackRoute.post(
  '/:id/acp-sessions/:sessionId/activity',
  jsonValidator(AcpSessionActivityReportSchema),
  async (c) => {
    // Verify callback JWT (not BetterAuth session cookie)
    const token = extractBearerToken(c.req.header('Authorization'));
    const payload = await verifyCallbackToken(token, c.env);

    if (payload.scope !== 'workspace' && payload.scope !== 'node') {
      log.error('acp_activity.invalid_token_scope', {
        scope: payload.scope,
        action: 'rejected',
      });
      throw errors.forbidden('Invalid token scope for activity report');
    }

    const projectId = c.req.param('id');
    const sessionId = c.req.param('sessionId');
    const body = c.req.valid('json');

    const existing = await projectDataService.getAcpSession(c.env, projectId, sessionId);
    if (!existing) {
      throw errors.notFound('ACP session not found');
    }

    // Authoritative auth: bind the token's OWN identity (payload.workspace) to the session's
    // node/workspace — never authorize on the client-supplied body.nodeId. A node-scoped token
    // must be the session's node; a workspace-scoped token must be the session's workspace. Without
    // this, any holder of a valid callback token (trivial to obtain once BYO self-enrollment ships)
    // could force ANOTHER tenant's session to error/failed. See .claude/rules/28 and security-critique #1.
    const tokenBoundToSession =
      callbackTokenMatchesNode(payload, existing.nodeId) ||
      callbackTokenMatchesWorkspace(payload, existing.workspaceId);
    if (!tokenBoundToSession) {
      log.error('acp_activity.callback_token_not_bound_to_session', {
        sessionId,
        projectId,
        scope: payload.scope,
        tokenIdentity: payload.workspace,
        sessionNodeId: existing.nodeId,
        sessionWorkspaceId: existing.workspaceId,
        action: 'rejected',
      });
      throw errors.forbidden('Callback token not authorized for this session');
    }

    // Defense-in-depth: the reported nodeId must still match the session's assigned node.
    if (existing.nodeId !== body.nodeId) {
      log.error('acp_activity.node_mismatch', {
        sessionId,
        projectId,
        expectedNodeId: existing.nodeId,
        receivedNodeId: body.nodeId,
        action: 'rejected',
      });
      throw errors.forbidden('Node identity verification failed');
    }

    await projectDataService.reportAcpSessionActivity(c.env, projectId, sessionId, body.activity, {
      promptStartedAt: body.promptStartedAt,
      agentType: body.agentType,
      restartCount: body.restartCount,
      statusError: body.statusError,
    });
    if (body.activity === 'error' && canTransitionAcpSessionToFailed(existing.status)) {
      const failureMessage = normalizeAgentErrorMessage(body.statusError);
      const db = drizzle(c.env.DATABASE, { schema });

      await db
        .update(schema.agentSessions)
        .set({
          status: 'error',
          errorMessage: failureMessage,
          updatedAt: new Date().toISOString(),
        })
        .where(eq(schema.agentSessions.id, sessionId))
        .catch((err) => {
          log.warn('acp_activity.agent_session_error_update_failed', {
            projectId,
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      await projectDataService
        .transitionAcpSession(c.env, projectId, sessionId, 'failed', {
          actorType: 'vm-agent',
          actorId: body.nodeId,
          reason: 'Agent activity reported error',
          errorMessage: failureMessage,
          metadata: {
            activity: body.activity,
            agentType: body.agentType ?? existing.agentType ?? null,
            restartCount: body.restartCount ?? null,
          },
        })
        .catch((err) => {
          log.warn('acp_activity.acp_session_fail_transition_failed', {
            projectId,
            sessionId,
            fromStatus: existing.status,
            error: err instanceof Error ? err.message : String(err),
          });
        });

      await projectDataService
        .failSession(c.env, projectId, existing.chatSessionId, failureMessage)
        .catch((err) => {
          log.warn('acp_activity.chat_session_fail_failed', {
            projectId,
            chatSessionId: existing.chatSessionId,
            sessionId,
            error: err instanceof Error ? err.message : String(err),
          });
        });
    }
    if (body.activity === 'idle' || body.activity === 'error') {
      if (
        body.activity === 'idle' &&
        existing.workspaceId &&
        existing.nodeId &&
        existing.acpSdkSessionId
      ) {
        const db = drizzle(c.env.DATABASE, { schema });
        const workspace = await db
          .select({
            id: schema.workspaces.id,
            userId: schema.workspaces.userId,
            chatSessionId: schema.workspaces.chatSessionId,
            runtime: schema.nodes.runtime,
          })
          .from(schema.workspaces)
          .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
          .where(eq(schema.workspaces.id, existing.workspaceId))
          .get();
        if (workspace?.runtime === 'cf-container' && workspace.chatSessionId) {
          await hibernateAgentSessionOnNode(
            existing.nodeId,
            existing.workspaceId,
            existing.acpSdkSessionId,
            c.env,
            workspace.userId,
            {
              chatSessionId: workspace.chatSessionId,
              runtime: 'cf-container',
            }
          ).catch((err) => {
            log.warn('acp_activity.session_snapshot_failed', {
              projectId,
              sessionId,
              workspaceId: existing.workspaceId,
              nodeId: existing.nodeId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
        }
      }
      await markVmAgentContainerActiveWorkEndedBestEffort(
        c.env,
        existing.nodeId,
        `agent_activity_${body.activity}`
      );
    }
    return c.body(null, 204);
  }
);

export { agentActivityCallbackRoute };
