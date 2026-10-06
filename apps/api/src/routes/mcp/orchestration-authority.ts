/**
 * Current-authority gate for destructive MCP orchestration controls.
 *
 * MCP tokens are opaque KV entries with a sliding TTL and a max lifetime
 * (`services/mcp-token.ts`). Nothing in that lifecycle observes project
 * membership, so a token minted while its actor was an active member stays
 * valid after the actor is removed from the project or downgraded to a role
 * without `task:write`. Task lineage does not close that gap either: a stored
 * `parent_task_id` records who dispatched the child once, not who may control
 * it now.
 *
 * Destructive child-control tools therefore have to re-derive the actor's
 * CURRENT relational membership from D1 before any effect — stopping a child
 * agent, writing task rows, creating chat sessions, attributing credentials, or
 * starting a runner. This mirrors `services/trigger-submit.ts`, which already
 * re-checks `task:write` on the trigger execution principal at execution time.
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
