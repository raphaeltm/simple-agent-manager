import type { Env } from '../env';
import { type JsonRpcResponse, jsonRpcSuccess, type McpTokenData } from '../routes/mcp/_helpers';
import { OperationError, operationErrorToWorkspaceJsonRpc } from './errors';
import {
  type platformOperations,
  samChatRead,
  samChatsSearch,
  samIdeaCreate,
  samIdeaGet,
  samIdeasSearch,
  samIdeaUpdate,
  samKnowledgeSearch,
  samProfilesList,
  samTaskGet,
  samTasksList,
} from './platform-operations';
import type { OperationContext } from './types';

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
  create_idea: samIdeaCreate,
  update_idea: samIdeaUpdate,
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
    requestId: String(requestId ?? ''),
    actor: {
      userId: token.userId,
      via: 'workspace-agent',
      scopes: new Set(['sam.read', 'sam.write']),
      workspace: { workspaceId: token.workspaceId, taskId: token.taskId, projectId },
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
