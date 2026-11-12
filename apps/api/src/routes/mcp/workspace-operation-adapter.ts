import type { Env } from '../../env';
import { createOperationPorts } from '../../operation-ports';
import { OperationError } from '../../operations/errors';
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
} from '../../operations/platform-operations';
import type { OperationContext } from '../../operations/types';
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
  if (params.projectId !== undefined && params.projectId !== projectId) {
    return operationErrorToWorkspaceJsonRpc(
      requestId,
      new OperationError('forbidden', 'Project does not match workspace token')
    );
  }
  const ctx: OperationContext = {
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
        projectId,
        agentSessionId: token.agentSessionId,
      },
    },
  };
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

/** The workspace protocol has historically used INVALID_PARAMS for tool-level failures. */
function operationErrorToWorkspaceJsonRpc(
  requestId: string | number | null,
  error: OperationError
): JsonRpcResponse {
  return jsonRpcError(
    requestId,
    error.code === 'unavailable' ? INTERNAL_ERROR : INVALID_PARAMS,
    error.message
  );
}
