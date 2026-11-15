/**
 * Current-authority gate for project-scoped MCP tools.
 *
 * MCP tokens are opaque KV entries with a sliding TTL and a max lifetime
 * (`services/mcp-token.ts`). The shared lifecycle gate rejects inactive
 * membership, but an active membership can still be downgraded to a role that
 * lacks a tool's required capability. Task lineage does not close that gap
 * either: a stored `parent_task_id` records who dispatched the child once, not
 * who may control it now.
 *
 * Sensitive tools therefore have to re-derive the actor's CURRENT relational
 * membership and role from D1 before reading project data or causing effects.
 * This mirrors `services/trigger-submit.ts`, which already re-checks `task:write`
 * on the trigger execution principal at execution time.
 *
 * The parent-only boundary is unchanged and complementary: lineage answers
 * "which task may control this child", this gate answers "may this actor still
 * act in this project at all". Both must hold.
 */
import { log } from '../../lib/logger';
import {
  type AppDb,
  hasProjectCapability,
  type ProjectCapability,
} from '../../middleware/project-auth';
import { INVALID_PARAMS, jsonRpcError, type JsonRpcResponse, type McpTokenData } from './_helpers';

/**
 * Capabilities whose loss must take effect on the next MCP call. The shared
 * dispatcher applies this table before invoking any listed handler, so aliases
 * and direct switch/table dispatch paths cannot skip the current-role check.
 */
const MCP_TOOL_PROJECT_CAPABILITIES = new Map<string, ProjectCapability>([
  // Project transcript and session history.
  ['list_sessions', 'task:read'],
  ['get_session_messages', 'task:read'],
  ['get_resource_history', 'task:read'],
  ['search_messages', 'task:read'],
  ['get_archived_tool_payloads', 'task:read'],
  ['update_session_topic', 'task:write'],

  // Deployment reads, releases, and secret-bearing environment configuration.
  ['list_deployment_environments', 'deployment:read'],
  ['read_deployment_logs', 'deployment:read'],
  ['preview_deployment_routes', 'deployment:read'],
  ['list_deployment_routes', 'deployment:read'],
  ['get_publish_status', 'deployment:read'],
  ['list_deployment_environment_config', 'secret:read'],
  ['set_deployment_environment_config', 'secret:write'],
  ['create_deployment_environment', 'deployment:deploy'],
  ['build_and_publish', 'deployment:deploy'],
  ['cancel_publish', 'deployment:deploy'],

  // Mission records and lifecycle controls.
  ['get_mission', 'task:read'],
  ['get_mission_state', 'task:read'],
  ['get_handoff', 'task:read'],
  ['get_orchestrator_status', 'task:read'],
  ['get_scheduling_queue', 'task:read'],
  ['create_mission', 'task:write'],
  ['publish_mission_state', 'task:write'],
  ['publish_handoff', 'task:write'],
  ['pause_mission', 'task:write'],
  ['resume_mission', 'task:write'],
  ['cancel_mission', 'task:write'],
  // override_task_state retains its handler-local gate as an additional task-scope boundary.
]);

export function getRequiredMcpProjectCapability(toolName: string): ProjectCapability | null {
  return MCP_TOOL_PROJECT_CAPABILITIES.get(toolName) ?? null;
}

/**
 * Returns a JSON-RPC error when the token's actor no longer holds `capability`
 * in the token's project, or `null` when the actor is still authorized.
 *
 * Fails closed: any failure to establish current authority (missing membership
 * row, removed/suspended membership, insufficient role) denies the call.
 */
export async function denyWhenMcpActorLacksCurrentProjectCapability(
  requestId: string | number | null,
  db: AppDb,
  tokenData: McpTokenData,
  capability: ProjectCapability,
  toolName: string
): Promise<JsonRpcResponse | null> {
  const authorized = await hasProjectCapability(
    db,
    tokenData.projectId,
    tokenData.userId,
    capability
  );
  if (authorized) return null;

  log.warn('mcp.orchestration.stale_actor_authority', {
    tool: toolName,
    callerTaskId: tokenData.taskId,
    projectId: tokenData.projectId,
    userId: tokenData.userId,
    workspaceId: tokenData.workspaceId,
    capability,
    action: 'rejected',
  });

  return jsonRpcError(
    requestId,
    INVALID_PARAMS,
    `This session's user no longer has '${capability}' access to the project, so ${toolName} is not permitted`
  );
}
