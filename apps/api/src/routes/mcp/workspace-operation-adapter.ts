import type { OperationContext } from '@simple-agent-manager/operations';
import { OperationError } from '@simple-agent-manager/operations';
import {
  type platformOperations,
  samChatRead,
  samChatsSearch,
  samIdeaCreate,
  samIdeaGet,
  samIdeasSearch,
  samIdeaUpdate,
  samIdeaUpdatesList,
  samKnowledgeSearch,
  samLinkedContextGet,
  samProfilesList,
  samTaskGet,
  samTasksList,
} from '@simple-agent-manager/operations';

import type { Env } from '../../env';
import { createOperationPorts } from '../../operation-ports';
import {
  INTERNAL_ERROR,
  INVALID_PARAMS,
  jsonRpcError,
  type JsonRpcResponse,
  jsonRpcSuccess,
  type McpTokenData,
} from './_helpers';

/** Workspace `sam-mcp` adapter: maps workspace tool names onto shared operations. */
const workspaceOperations: Record<string, (typeof platformOperations)[number]> = {
  get_task_details: samTaskGet,
  list_tasks: samTasksList,
  search_tasks: samTasksList,
  get_session_messages: samChatRead,
  search_messages: samChatsSearch,
  list_ideas: samIdeasSearch,
  search_ideas: samIdeasSearch,
  find_related_ideas: samIdeasSearch,
  get_idea: samIdeaGet,
  get_linked_context: samLinkedContextGet,
  create_idea: samIdeaCreate,
  update_idea: samIdeaUpdate,
  list_idea_updates: samIdeaUpdatesList,
  search_knowledge: samKnowledgeSearch,
  list_agent_profiles: samProfilesList,
};

export async function runWorkspaceOperation(
  name: keyof typeof workspaceOperations,
  requestId: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData,
  env: Env
): Promise<JsonRpcResponse> {
  const projectId = token.projectId;
  const mismatch = projectMismatch(requestId, params, token);
  if (mismatch) return mismatch;
  const ctx = workspaceOperationContext(requestId, token, env);
  const operation = workspaceOperations[name];
  if (!operation) throw new OperationError('invalid_input', `Unknown workspace operation: ${name}`);
  const input = {
    ...params,
    projectId,
    ...(name === 'find_related_ideas' ? { related: true } : {}),
    ...(name === 'search_tasks' || name === 'search_ideas' ? { search: true } : {}),
  };
  try {
    // Workspace schemas are kept in the existing MCP tool catalog. Validation there
    // preserves its historical error messages; operation schemas serve other adapters.
    const result = await operation.run(ctx, input as never);
    return jsonRpcSuccess(requestId, {
      content: [{ type: 'text', text: JSON.stringify(result, null, 2) }],
    });
  } catch (error) {
    if (error instanceof OperationError) return operationErrorToWorkspaceJsonRpc(requestId, error);
    throw error;
  }
}

/** A workspace token may only read its own project; a different `projectId` is refused (rule 51). */
export function projectMismatch(
  requestId: string | number | null,
  params: Record<string, unknown>,
  token: McpTokenData
): JsonRpcResponse | null {
  if (params.projectId === undefined || params.projectId === token.projectId) return null;
  return operationErrorToWorkspaceJsonRpc(
    requestId,
    new OperationError('forbidden', 'Project does not match workspace token')
  );
}

/** The operation context for a workspace MCP token: its user, its project, nothing else. */
export function workspaceOperationContext(
  requestId: string | number | null,
  token: McpTokenData,
  env: Env
): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    requestId: String(requestId ?? ''),
    actor: {
      userId: token.userId,
      via: 'workspace-agent',
      scopes: new Set(['sam.read', 'sam.write']),
      workspace: {
        workspaceId: token.workspaceId,
        taskId: token.taskId,
        projectId: token.projectId,
        agentSessionId: token.agentSessionId,
      },
    },
  };
}

/** The workspace protocol has historically used INVALID_PARAMS for tool-level failures. */
export function operationErrorToWorkspaceJsonRpc(
  requestId: string | number | null,
  error: OperationError
): JsonRpcResponse {
  return jsonRpcError(
    requestId,
    error.code === 'unavailable' ? INTERNAL_ERROR : INVALID_PARAMS,
    error.message
  );
}
