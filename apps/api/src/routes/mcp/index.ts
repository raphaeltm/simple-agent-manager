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

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  authenticateMcpRequest,
  checkMcpRateLimit,
  getMcpRateLimit,
  INTERNAL_ERROR,
  jsonRpcError,
  type JsonRpcRequest,
  jsonRpcSuccess,
  MCP_PROTOCOL_VERSION,
  MCP_SERVER_NAME,
  MCP_SERVER_VERSION,
  MCP_TOOLS,
  METHOD_NOT_FOUND,
} from './_helpers';
import { handleBuildAndPublish, handleGetPublishStatus } from './compose-publish-tools';
import { handleGetDeploymentGuide } from './deployment-guide-tools';
import {
  handleCreateDeploymentEnvironment,
  handleListDeploymentEnvironmentConfig,
  handleListDeploymentEnvironments,
  handleListDeploymentRoutes,
  handlePreviewDeploymentRoutes,
  handleReadDeploymentLogs,
  handleSetDeploymentEnvironmentConfig,
} from './deployment-tools';
import { handleDispatchTask } from './dispatch-tool';
import {
  handleCreateIdea,
  handleFindRelatedIdeas,
  handleGetIdea,
  handleLinkIdea,
  handleListIdeas,
  handleListLinkedIdeas,
  handleSearchIdeas,
  handleUnlinkIdea,
  handleUpdateIdea,
} from './idea-tools';
import { handleGetInstructions, handleRequestHumanInput } from './instruction-tools';
import {
  handleAddKnowledge,
  handleConfirmKnowledge,
  handleFlagContradiction,
  handleGetKnowledge,
  handleGetProjectKnowledge,
  handleGetRelated,
  handleGetRelevantKnowledge,
  handleRelateKnowledge,
  handleRemoveKnowledge,
  handleSearchKnowledge,
  handleUpdateKnowledge,
} from './knowledge-tools';
import {
  handleDisplayFromLibrary,
  handleDownloadLibraryFile,
  handleListLibraryFiles,
  handleReplaceLibraryFile,
  handleUploadToLibrary,
} from './library-tools';
import {
  handleAckMessage,
  handleGetPendingMessages,
  handleSendDurableMessage,
} from './mailbox-tools';
import {
  handleCreateMission,
  handleGetHandoff,
  handleGetMission,
  handleGetMissionState,
  handlePublishHandoff,
  handlePublishMissionState,
} from './mission-tools';
import { handleGetRepoSetupGuide } from './onboarding-tools';
import { handleSendMessageToSubtask, handleStopSubtask } from './orchestration-comms';
import {
  handleAddDependency,
  handleRemovePendingSubtask,
  handleRetrySubtask,
} from './orchestration-tools';
import {
  handleCancelMission as handleCancelMissionOrch,
  handleGetOrchestratorStatus,
  handleGetSchedulingQueue,
  handleOverrideTaskState,
  handlePauseMission as handlePauseMissionOrch,
  handleResumeMission as handleResumeMissionOrch,
} from './orchestrator-lifecycle-tools';
import {
  handleAddPolicy,
  handleGetPolicy,
  handleListPolicies,
  handleRemovePolicy,
  handleUpdatePolicy,
} from './policy-tools';
import {
  handleAddProfileEnvVar,
  handleCreateAgentProfile,
  handleDeleteAgentProfile,
  handleGetAgentProfile,
  handleListAgentProfiles,
  handleListProfileEnvVars,
  handleRemoveProfileEnvVar,
  handleUpdateAgentProfile,
} from './profile-tools';
import {
  handleGetSessionMessages,
  handleListSessions,
  handleSearchMessages,
  handleUpdateSessionTopic,
} from './session-tools';
import {
  handleCreateSkill,
  handleDeleteSkill,
  handleGetSkill,
  handleListSkills,
  handleUpdateSkill,
} from './skill-tools';
import {
  handleCompleteTask,
  handleGetTaskDetails,
  handleListTasks,
  handleSearchTasks,
  handleUpdateTaskStatus,
} from './task-tools';
import { handleCreateTrigger, handleDeleteTrigger, handleUpdateTrigger } from './trigger-tools';
import {
  handleExposePort,
  handleGetCredentialStatus,
  handleGetNetworkInfo,
  handleGetWorkspaceDiffSummary,
  handleGetWorkspaceInfo,
} from './workspace-tools';
import {
  handleCheckDnsStatus,
  handleGetPeerAgentOutput,
  handleGetTaskDependencies,
  handleListProjectAgents,
  handleReportEnvironmentIssue,
} from './workspace-tools-direct';

// Re-export public API for backward compatibility
export type { TokenRow } from './session-tools';
export { groupTokensIntoMessages } from './session-tools';

export const mcpRoutes = new Hono<{ Bindings: Env }>();

// ─── MCP endpoint ────────────────────────────────────────────────────────────

mcpRoutes.post('/', async (c) => {
  // NOSONAR - legacy MCP dispatcher switch is intentionally centralized.
  // Authenticate — returns parsed token data
  const [tokenData] = await authenticateMcpRequest(c.req.header('Authorization'), c.env.KV, c.env);
  if (!tokenData) {
    return c.json(jsonRpcError(null, -32000, 'Unauthorized: invalid or expired MCP token'), 401);
  }

  // Parse JSON-RPC body before rate limiting so notifications can exit early
  let rpc: JsonRpcRequest;
  try {
    rpc = await c.req.json<JsonRpcRequest>();
  } catch {
    return c.json(jsonRpcError(null, -32700, 'Parse error: invalid JSON'), 400);
  }

  if (Array.isArray(rpc)) {
    return c.json(jsonRpcError(null, -32600, 'Batch requests are not supported'), 400);
  }

  if (rpc.jsonrpc !== '2.0') {
    return c.json(
      jsonRpcError(rpc.id ?? null, -32600, 'Invalid Request: missing jsonrpc 2.0'),
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

  // After the notification guard above, rpc.id is always defined (string | number | null).
  // The ?? null satisfies TypeScript since 'id' in rpc doesn't narrow the optional type.
  const requestId = rpc.id ?? null;

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
          case 'update_task_status':
            return c.json(await handleUpdateTaskStatus(requestId, toolArgs, tokenData, c.env));
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
          case 'request_human_input':
            return c.json(await handleRequestHumanInput(requestId, toolArgs, tokenData, c.env));
          case 'dispatch_task': {
            let execCtx: { waitUntil(p: Promise<unknown>): void } | undefined;
            try {
              execCtx = typeof c.executionCtx.waitUntil === 'function' ? c.executionCtx : undefined;
            } catch {
              execCtx = undefined;
            }
            return c.json(await handleDispatchTask(requestId, toolArgs, tokenData, c.env, execCtx));
          }
          // ─── Durable messaging tools ──────────────────────────────────
          case 'send_durable_message':
            return c.json(await handleSendDurableMessage(requestId, toolArgs, tokenData, c.env));
          case 'get_pending_messages':
            return c.json(await handleGetPendingMessages(requestId, toolArgs, tokenData, c.env));
          case 'ack_message':
            return c.json(await handleAckMessage(requestId, toolArgs, tokenData, c.env));
          case 'send_message_to_subtask':
            return c.json(await handleSendMessageToSubtask(requestId, toolArgs, tokenData, c.env));
          case 'stop_subtask':
            return c.json(await handleStopSubtask(requestId, toolArgs, tokenData, c.env));
          case 'retry_subtask':
            return c.json(await handleRetrySubtask(requestId, toolArgs, tokenData, c.env));
          case 'add_dependency':
            return c.json(await handleAddDependency(requestId, toolArgs, tokenData, c.env));
          case 'remove_pending_subtask':
            return c.json(await handleRemovePendingSubtask(requestId, toolArgs, tokenData, c.env));
          case 'list_tasks':
            return c.json(await handleListTasks(requestId, toolArgs, tokenData, c.env));
          case 'get_task_details':
            return c.json(await handleGetTaskDetails(requestId, toolArgs, tokenData, c.env));
          case 'search_tasks':
            return c.json(await handleSearchTasks(requestId, toolArgs, tokenData, c.env));
          case 'list_sessions':
            return c.json(await handleListSessions(requestId, toolArgs, tokenData, c.env));
          case 'get_session_messages':
            return c.json(await handleGetSessionMessages(requestId, toolArgs, tokenData, c.env));
          case 'search_messages':
            return c.json(await handleSearchMessages(requestId, toolArgs, tokenData, c.env));
          case 'update_session_topic':
            return c.json(await handleUpdateSessionTopic(requestId, toolArgs, tokenData, c.env));
          case 'link_idea':
            return c.json(await handleLinkIdea(requestId, toolArgs, tokenData, c.env));
          case 'unlink_idea':
            return c.json(await handleUnlinkIdea(requestId, toolArgs, tokenData, c.env));
          case 'list_linked_ideas':
            return c.json(await handleListLinkedIdeas(requestId, toolArgs, tokenData, c.env));
          case 'find_related_ideas':
            return c.json(await handleFindRelatedIdeas(requestId, toolArgs, tokenData, c.env));
          case 'create_idea':
            return c.json(await handleCreateIdea(requestId, toolArgs, tokenData, c.env));
          case 'update_idea':
            return c.json(await handleUpdateIdea(requestId, toolArgs, tokenData, c.env));
          case 'get_idea':
            return c.json(await handleGetIdea(requestId, toolArgs, tokenData, c.env));
          case 'list_ideas':
            return c.json(await handleListIdeas(requestId, toolArgs, tokenData, c.env));
          case 'search_ideas':
            return c.json(await handleSearchIdeas(requestId, toolArgs, tokenData, c.env));
          case 'build_and_publish':
            return c.json(await handleBuildAndPublish(requestId, toolArgs, tokenData, c.env));
          case 'get_publish_status':
            return c.json(await handleGetPublishStatus(requestId, toolArgs, tokenData, c.env));
          case 'create_deployment_environment':
            return c.json(
              await handleCreateDeploymentEnvironment(requestId, toolArgs, tokenData, c.env)
            );
          case 'list_deployment_environments':
            return c.json(
              await handleListDeploymentEnvironments(requestId, toolArgs, tokenData, c.env)
            );
          case 'read_deployment_logs':
            return c.json(await handleReadDeploymentLogs(requestId, toolArgs, tokenData, c.env));
          case 'preview_deployment_routes':
            return c.json(
              await handlePreviewDeploymentRoutes(requestId, toolArgs, tokenData, c.env)
            );
          case 'list_deployment_routes':
            return c.json(await handleListDeploymentRoutes(requestId, toolArgs, tokenData, c.env));
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
          case 'get_workspace_info':
            return c.json(await handleGetWorkspaceInfo(requestId, tokenData, c.env));
          case 'get_credential_status':
            return c.json(await handleGetCredentialStatus(requestId, tokenData, c.env));
          case 'get_network_info':
            return c.json(await handleGetNetworkInfo(requestId, tokenData, c.env));
          case 'expose_port':
            return c.json(await handleExposePort(requestId, toolArgs, tokenData, c.env));
          case 'check_dns_status':
            return c.json(await handleCheckDnsStatus(requestId, tokenData, c.env));
          case 'list_project_agents':
            return c.json(await handleListProjectAgents(requestId, tokenData, c.env));
          case 'get_peer_agent_output':
            return c.json(await handleGetPeerAgentOutput(requestId, toolArgs, tokenData, c.env));
          case 'get_task_dependencies':
            return c.json(await handleGetTaskDependencies(requestId, tokenData, c.env));
          case 'get_workspace_diff_summary':
            return c.json(await handleGetWorkspaceDiffSummary(requestId, tokenData, c.env));
          case 'report_environment_issue':
            return c.json(
              await handleReportEnvironmentIssue(requestId, toolArgs, tokenData, c.env)
            );
          // ─── Project file library tools ─────────────────────────────────
          case 'list_library_files':
            return c.json(await handleListLibraryFiles(requestId, toolArgs, tokenData, c.env));
          case 'download_library_file':
            return c.json(await handleDownloadLibraryFile(requestId, toolArgs, tokenData, c.env));
          case 'upload_to_library':
            return c.json(await handleUploadToLibrary(requestId, toolArgs, tokenData, c.env));
          case 'replace_library_file':
            return c.json(await handleReplaceLibraryFile(requestId, toolArgs, tokenData, c.env));
          case 'display_from_library':
            return c.json(await handleDisplayFromLibrary(requestId, toolArgs, tokenData, c.env));
          // ─── Trigger management tools ────────────────────────────────
          case 'create_trigger':
            return c.json(await handleCreateTrigger(requestId, toolArgs, tokenData, c.env));
          case 'update_trigger':
            return c.json(await handleUpdateTrigger(requestId, toolArgs, tokenData, c.env));
          case 'delete_trigger':
            return c.json(await handleDeleteTrigger(requestId, toolArgs, tokenData, c.env));
          // ─── Agent profile tools ──────────────────────────────────────
          case 'list_agent_profiles':
            return c.json(await handleListAgentProfiles(requestId, toolArgs, tokenData, c.env));
          case 'get_agent_profile':
            return c.json(await handleGetAgentProfile(requestId, toolArgs, tokenData, c.env));
          case 'create_agent_profile':
            return c.json(await handleCreateAgentProfile(requestId, toolArgs, tokenData, c.env));
          case 'update_agent_profile':
            return c.json(await handleUpdateAgentProfile(requestId, toolArgs, tokenData, c.env));
          case 'delete_agent_profile':
            return c.json(await handleDeleteAgentProfile(requestId, toolArgs, tokenData, c.env));
          case 'add_profile_env_var':
            return c.json(await handleAddProfileEnvVar(requestId, toolArgs, tokenData, c.env));
          case 'remove_profile_env_var':
            return c.json(await handleRemoveProfileEnvVar(requestId, toolArgs, tokenData, c.env));
          case 'list_profile_env_vars':
            return c.json(await handleListProfileEnvVars(requestId, toolArgs, tokenData, c.env));
          // ─── Skill tools ──────────────────────────────────────────────
          case 'list_skills':
            return c.json(await handleListSkills(requestId, toolArgs, tokenData, c.env));
          case 'get_skill':
            return c.json(await handleGetSkill(requestId, toolArgs, tokenData, c.env));
          case 'create_skill':
            return c.json(await handleCreateSkill(requestId, toolArgs, tokenData, c.env));
          case 'update_skill':
            return c.json(await handleUpdateSkill(requestId, toolArgs, tokenData, c.env));
          case 'delete_skill':
            return c.json(await handleDeleteSkill(requestId, toolArgs, tokenData, c.env));
          // ─── Onboarding tools ─────────────────────────────────────────
          case 'get_repo_setup_guide':
            // Synchronous — no async I/O needed for static content
            return c.json(handleGetRepoSetupGuide(requestId));
          // ─── Knowledge graph tools ───────────────────────────────────────
          case 'add_knowledge':
            return c.json(await handleAddKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'update_knowledge':
            return c.json(await handleUpdateKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'remove_knowledge':
            return c.json(await handleRemoveKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'get_knowledge':
            return c.json(await handleGetKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'search_knowledge':
            return c.json(await handleSearchKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'get_project_knowledge':
            return c.json(await handleGetProjectKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'get_relevant_knowledge':
            return c.json(await handleGetRelevantKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'relate_knowledge':
            return c.json(await handleRelateKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'get_related':
            return c.json(await handleGetRelated(requestId, toolArgs, tokenData, c.env));
          case 'confirm_knowledge':
            return c.json(await handleConfirmKnowledge(requestId, toolArgs, tokenData, c.env));
          case 'flag_contradiction':
            return c.json(await handleFlagContradiction(requestId, toolArgs, tokenData, c.env));
          // ─── Mission orchestration tools ───────────────────────────────
          case 'create_mission':
            return c.json(await handleCreateMission(requestId, toolArgs, tokenData, c.env));
          case 'get_mission':
            return c.json(await handleGetMission(requestId, toolArgs, tokenData, c.env));
          case 'publish_mission_state':
            return c.json(await handlePublishMissionState(requestId, toolArgs, tokenData, c.env));
          case 'get_mission_state':
            return c.json(await handleGetMissionState(requestId, toolArgs, tokenData, c.env));
          case 'publish_handoff':
            return c.json(await handlePublishHandoff(requestId, toolArgs, tokenData, c.env));
          case 'get_handoff':
            return c.json(await handleGetHandoff(requestId, toolArgs, tokenData, c.env));
          // ─── Orchestrator lifecycle tools ──────────────────────────────
          case 'get_orchestrator_status':
            return c.json(await handleGetOrchestratorStatus(requestId, toolArgs, tokenData, c.env));
          case 'get_scheduling_queue':
            return c.json(await handleGetSchedulingQueue(requestId, toolArgs, tokenData, c.env));
          case 'pause_mission':
            return c.json(await handlePauseMissionOrch(requestId, toolArgs, tokenData, c.env));
          case 'resume_mission':
            return c.json(await handleResumeMissionOrch(requestId, toolArgs, tokenData, c.env));
          case 'cancel_mission':
            return c.json(await handleCancelMissionOrch(requestId, toolArgs, tokenData, c.env));
          case 'override_task_state':
            return c.json(await handleOverrideTaskState(requestId, toolArgs, tokenData, c.env));
          // ─── Project policy tools (Phase 4) ──────────────────────────────
          case 'add_policy':
            return c.json(await handleAddPolicy(requestId, toolArgs, tokenData, c.env));
          case 'list_policies':
            return c.json(await handleListPolicies(requestId, toolArgs, tokenData, c.env));
          case 'get_policy':
            return c.json(await handleGetPolicy(requestId, toolArgs, tokenData, c.env));
          case 'update_policy':
            return c.json(await handleUpdatePolicy(requestId, toolArgs, tokenData, c.env));
          case 'remove_policy':
            return c.json(await handleRemovePolicy(requestId, toolArgs, tokenData, c.env));
          default:
            return c.json(jsonRpcError(requestId, METHOD_NOT_FOUND, `Unknown tool: ${toolName}`));
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
