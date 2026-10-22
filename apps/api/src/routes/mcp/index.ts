/**
 * MCP Server Route
 *
 * Implements a lightweight MCP (Model Context Protocol) server using
 * JSON-RPC 2.0 over HTTP (Streamable HTTP transport). Exposes tools
 * to agents running in SAM workspaces.
 *
 * Auth: task-scoped opaque token stored in KV, passed as Bearer token.
 */
import { Hono } from 'hono';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { formatIssues, JsonRpcEnvelopeSchema } from '../../schemas';
import {
  authenticateMcpRequest,
  checkMcpRateLimit,
  getMcpRateLimit,
  INTERNAL_ERROR,
  jsonRpcError,
  jsonRpcSuccess,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
  METHOD_NOT_FOUND,
} from './_helpers';
import {
  handleCreateMessageCommentThread,
  handleGetMessageCommentThread,
  handleListMessageCommentThreads,
  handleReopenMessageCommentThread,
  handleReplyToMessageCommentThread,
  handleResolveMessageCommentThread,
} from './comment-tools';
import { handleGetDeploymentGuide } from './deployment-guide-tools';
import {
  handleCreateDeploymentEnvironment,
  handleListDeploymentEnvironmentConfig,
  handleListDeploymentEnvironments,
  handlePreviewDeploymentRoutes,
  handleSetDeploymentEnvironmentConfig,
} from './deployment-tools';
import { handleDispatchTask } from './dispatch-tool';
import {
  handleCancelProjectEventSubscription,
  handleCreateProjectEventSubscription,
  handleGetProjectEventSubscription,
  handleListProjectEventSubscriptions,
} from './event-subscription-tools';
import { handleGetInstructions } from './instruction-tools';
import {
  handleCreateLibraryFileCommentThread,
  handleListLibraryFileCommentThreads,
} from './library-file-comment-tools';
import { handleGetRepoSetupGuide } from './onboarding-tools';
import { handleChannelTool } from './project-event-channel-tools';
import { handleListSubscriptionEvents } from './project-event-tools';
import { handleScheduleTool } from './project-schedule-tools';
import { handleSecretExec } from './secret-exec-tools';
import { handleGetArchivedToolPayloads } from './session-tools';
import { handleTaskPullRequestAssociation } from './task-pr-association-tools';
import { handleCompleteTask } from './task-tools';
import { MCP_TOOL_HANDLERS } from './tool-handler-table';
import { webhookClaimRoutes } from './webhook-claims';
import {
  handleGetCredentialStatus,
  handleGetNetworkInfo,
  handleGetWorkspaceDiffSummary,
  handleGetWorkspaceInfo,
} from './workspace-tools';
import {
  handleCheckDnsStatus,
  handleGetTaskDependencies,
  handleReportEnvironmentIssue,
} from './workspace-tools-direct';

// Re-export public API for backward compatibility
export type { TokenRow } from './session-tools';
export { groupTokensIntoMessages } from './session-tools';

export const mcpRoutes = new Hono<{ Bindings: Env }>();

// ─── MCP endpoint ────────────────────────────────────────────────────────────

/**
 * Narrow a parsed JSON-RPC `id` to the JSON-RPC-legal shapes (string | number
 * | null). A spec-noncompliant id (wrong type) degrades to null for response
 * correlation rather than rejecting the whole request — id is client-side
 * correlation metadata, not something the server should enforce strictly.
 */
function normalizeRpcId(id: unknown): string | number | null {
  return typeof id === 'string' || typeof id === 'number' ? id : null;
}

mcpRoutes.route('/', webhookClaimRoutes);

mcpRoutes.post('/', async (c) => {
  // NOSONAR - legacy MCP dispatcher switch is intentionally centralized.
  // Authenticate — returns parsed token data
  const [tokenData] = await authenticateMcpRequest(c.req.header('Authorization'), c.env.KV, c.env);
  if (!tokenData) {
    return c.json(jsonRpcError(null, -32000, 'Unauthorized: invalid or expired MCP token'), 401);
  }

  // Parse JSON-RPC body before rate limiting so notifications can exit early
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json(jsonRpcError(null, -32700, 'Parse error: invalid JSON'), 400);
  }

  if (Array.isArray(raw)) {
    return c.json(jsonRpcError(null, -32600, 'Batch requests are not supported'), 400);
  }

  // Structural validation only — replaces the previous unsafe generically-typed
  // parse with a real check that the body is a JSON object (so a `null`/primitive
  // body degrades to a normal 400 instead of crashing below). jsonrpc/method/params
  // stay unknown in JsonRpcEnvelopeSchema on purpose: the checks below already
  // enforce their exact accepted shapes with the JSON-RPC-shaped error responses
  // MCP clients depend on, so this schema must not preempt them or change their
  // error code/shape.
  const parsedRpc = v.safeParse(JsonRpcEnvelopeSchema, raw);
  if (!parsedRpc.success) {
    return c.json(
      jsonRpcError(null, -32600, `Invalid Request: ${formatIssues(parsedRpc.issues)}`),
      400
    );
  }
  const rpc = parsedRpc.output;

  if (rpc.jsonrpc !== '2.0') {
    return c.json(
      jsonRpcError(normalizeRpcId(rpc.id), -32600, 'Invalid Request: missing jsonrpc 2.0'),
      400
    );
  }

  // MCP Streamable HTTP: notifications have no `id` member (field absent).
  // Per spec, return 202 Accepted with no body. Skip rate limiting for
  // notifications since they are fire-and-forget and should not burn quota.
  if (!('id' in rpc)) {
    return new Response(null, { status: 202 });
  }

  // ── HTTP-level rate limiting (per task/agent) ───────────────────────────
  // Use taskId for task-runner sessions; fall back to agentSessionId for direct project-chat sessions
  const rateLimitKey = tokenData.taskId || tokenData.agentSessionId || tokenData.workspaceId;
  const rlResult = await checkMcpRateLimit(c.env.KV, rateLimitKey, c.env);
  c.header('X-RateLimit-Limit', getMcpRateLimit(c.env).toString());
  c.header('X-RateLimit-Remaining', rlResult.remaining.toString());
  c.header('X-RateLimit-Reset', rlResult.resetAt.toString());
  if (!rlResult.allowed) {
    c.header('Retry-After', rlResult.retryAfter.toString());
    return c.json(
      jsonRpcError(null, -32000, 'Rate limit exceeded. Please retry after the indicated period.'),
      429
    );
  }

  // After the notification guard above, rpc.id is always present.
  const requestId = normalizeRpcId(rpc.id);

  // Route by method
  switch (rpc.method) {
    // MCP protocol: list available tools
    case 'tools/list': {
      return c.json(jsonRpcSuccess(requestId, { tools: MCP_TOOLS }));
    }

    // MCP protocol: call a tool
    case 'tools/call': {
      const toolName = (rpc.params as { name?: string })?.name;
      const toolArgs = (rpc.params as { arguments?: Record<string, unknown> })?.arguments ?? {};

      try {
        switch (toolName) {
          case 'get_instructions':
            return c.json(await handleGetInstructions(requestId, tokenData, c.env));
          case 'complete_task': {
            // executionCtx may not be available in test environments (Miniflare/vitest)
            let execCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
            try {
              execCtx = typeof c.executionCtx.waitUntil === 'function' ? c.executionCtx : undefined;
            } catch {
              execCtx = undefined;
            }
            const response = await handleCompleteTask(
              requestId,
              toolArgs,
              tokenData,
              c.env,
              execCtx
            );
            const httpStatus =
              response.error?.data &&
              typeof response.error.data === 'object' &&
              'httpStatus' in response.error.data &&
              response.error.data.httpStatus === 400
                ? 400
                : 200;
            return c.json(response, httpStatus);
          }
          case 'dispatch_task': {
            let execCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
            try {
              execCtx = typeof c.executionCtx.waitUntil === 'function' ? c.executionCtx : undefined;
            } catch {
              execCtx = undefined;
            }
            return c.json(await handleDispatchTask(requestId, toolArgs, tokenData, c.env, execCtx));
          }
          case 'create_project_schedule':
          case 'list_project_schedules':
          case 'get_project_schedule':
          case 'reschedule_project_schedule':
          case 'cancel_project_schedule':
          case 'reconcile_project_schedule':
            return c.json(
              await handleScheduleTool(toolName, requestId, toolArgs, tokenData, c.env)
            );
          case 'publish_channel_event':
          case 'list_event_channels':
          case 'list_channel_subscribers':
          case 'get_channel_history':
          case 'follow_event_channel':
          case 'catch_up_event_channel':
            return c.json(await handleChannelTool(toolName, requestId, toolArgs, tokenData, c.env));
          case 'create_project_event_subscription':
            return c.json(
              await handleCreateProjectEventSubscription(requestId, toolArgs, tokenData, c.env)
            );
          case 'list_project_event_subscriptions':
            return c.json(
              await handleListProjectEventSubscriptions(requestId, toolArgs, tokenData, c.env)
            );
          case 'get_project_event_subscription':
            return c.json(
              await handleGetProjectEventSubscription(requestId, toolArgs, tokenData, c.env)
            );
          case 'cancel_project_event_subscription':
            return c.json(
              await handleCancelProjectEventSubscription(requestId, toolArgs, tokenData, c.env)
            );
          case 'list_subscription_events':
            return c.json(
              await handleListSubscriptionEvents(requestId, toolArgs, tokenData, c.env)
            );
          // ─── Durable messaging tools ──────────────────────────────────
          case 'list_message_comment_threads':
            return c.json(
              await handleListMessageCommentThreads(requestId, toolArgs, tokenData, c.env)
            );
          case 'get_message_comment_thread':
            return c.json(
              await handleGetMessageCommentThread(requestId, toolArgs, tokenData, c.env)
            );
          case 'create_message_comment_thread':
            return c.json(
              await handleCreateMessageCommentThread(requestId, toolArgs, tokenData, c.env)
            );
          case 'reply_to_message_comment_thread':
            return c.json(
              await handleReplyToMessageCommentThread(requestId, toolArgs, tokenData, c.env)
            );
          case 'resolve_message_comment_thread':
            return c.json(
              await handleResolveMessageCommentThread(requestId, toolArgs, tokenData, c.env)
            );
          case 'reopen_message_comment_thread':
            return c.json(
              await handleReopenMessageCommentThread(requestId, toolArgs, tokenData, c.env)
            );
          case 'list_library_file_comment_threads':
            return c.json(
              await handleListLibraryFileCommentThreads(requestId, toolArgs, tokenData, c.env)
            );
          case 'create_library_file_comment_thread':
            return c.json(
              await handleCreateLibraryFileCommentThread(requestId, toolArgs, tokenData, c.env)
            );
          case 'get_archived_tool_payloads':
            return c.json(
              await handleGetArchivedToolPayloads(requestId, toolArgs, tokenData, c.env)
            );
          case 'create_deployment_environment':
            return c.json(
              await handleCreateDeploymentEnvironment(requestId, toolArgs, tokenData, c.env)
            );
          case 'list_deployment_environments':
            return c.json(
              await handleListDeploymentEnvironments(requestId, toolArgs, tokenData, c.env)
            );
          case 'preview_deployment_routes':
            return c.json(
              await handlePreviewDeploymentRoutes(requestId, toolArgs, tokenData, c.env)
            );
          case 'list_deployment_environment_config':
            return c.json(
              await handleListDeploymentEnvironmentConfig(requestId, toolArgs, tokenData, c.env)
            );
          case 'set_deployment_environment_config':
            return c.json(
              await handleSetDeploymentEnvironmentConfig(requestId, toolArgs, tokenData, c.env)
            );
          case 'get_deployment_guide':
            // Synchronous — no async I/O needed for static content
            return c.json(handleGetDeploymentGuide(requestId));
          // ─── Workspace tools (unified from workspace-mcp) ──────────────
          case 'exec_with_secrets':
            return c.json(await handleSecretExec(requestId, toolArgs, tokenData, c.env, 'start'));
          case 'exec_with_secrets_status':
            return c.json(await handleSecretExec(requestId, toolArgs, tokenData, c.env, 'status'));
          case 'exec_with_secrets_cancel':
            return c.json(await handleSecretExec(requestId, toolArgs, tokenData, c.env, 'cancel'));
          case 'get_workspace_info':
            return c.json(await handleGetWorkspaceInfo(requestId, tokenData, c.env));
          case 'get_credential_status':
            return c.json(await handleGetCredentialStatus(requestId, tokenData, c.env));
          case 'get_network_info':
            return c.json(await handleGetNetworkInfo(requestId, tokenData, c.env));
          case 'check_dns_status':
            return c.json(await handleCheckDnsStatus(requestId, tokenData, c.env));
          case 'associate_pull_request':
          case 'list_pull_request_associations':
            return c.json(
              await handleTaskPullRequestAssociation(
                toolName,
                requestId,
                toolArgs,
                tokenData,
                c.env
              )
            );
          case 'get_task_dependencies':
            return c.json(await handleGetTaskDependencies(requestId, tokenData, c.env));
          case 'get_workspace_diff_summary':
            return c.json(await handleGetWorkspaceDiffSummary(requestId, tokenData, c.env));
          case 'report_environment_issue':
            return c.json(
              await handleReportEnvironmentIssue(requestId, toolArgs, tokenData, c.env)
            );
          // ─── Project file library tools ─────────────────────────────────
          // ─── Trigger management tools ────────────────────────────────
          // ─── Private incident backlog tools ───────────────────────────
          // ─── Agent profile tools ──────────────────────────────────────
          // ─── Skill tools ──────────────────────────────────────────────
          // ─── Onboarding tools ─────────────────────────────────────────
          case 'get_repo_setup_guide':
            // Synchronous — no async I/O needed for static content
            return c.json(handleGetRepoSetupGuide(requestId));
          // ─── Knowledge graph tools ───────────────────────────────────────
          // ─── Mission orchestration tools ───────────────────────────────
          // ─── Orchestrator lifecycle tools ──────────────────────────────
          // ─── Project policy tools (Phase 4) ──────────────────────────────
          default: {
            // One-line tools are dispatched from the shared handler table.
            const handler = toolName ? MCP_TOOL_HANDLERS.get(toolName) : undefined;
            if (handler) return c.json(await handler(requestId, toolArgs, tokenData, c.env));
            return c.json(jsonRpcError(requestId, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`));
          }
        }
      } catch (err) {
        const message = err instanceof Error ? err.message : 'Tool execution failed';
        const name = toolName ?? '<unknown>';
        log.error('mcp.tool_call_failed', { tool: name, error: String(err) });
        return c.json(jsonRpcError(requestId, INTERNAL_ERROR, `Tool '${name}' failed: ${message}`));
      }
    }

    // MCP protocol: initialize
    case 'initialize': {
      return c.json(
        jsonRpcSuccess(requestId, {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: MCP_SERVER_NAME, version: MCP_SERVER_VERSION },
        })
      );
    }

    // MCP protocol: ping
    case 'ping': {
      return c.json(jsonRpcSuccess(requestId, {}));
    }

    default:
      return c.json(jsonRpcError(requestId, METHOD_NOT_FOUND, `Method not found: ${rpc.method}`));
  }
});

// MCP Streamable HTTP: GET returns SSE stream or 405 if unsupported
mcpRoutes.get('/', (c) => {
  c.header('Allow', 'POST');
  return c.text('Method Not Allowed', 405);
});

// MCP Streamable HTTP: DELETE terminates session or 405 if unsupported
mcpRoutes.delete('/', (c) => {
  c.header('Allow', 'POST');
  return c.text('Method Not Allowed', 405);
});
