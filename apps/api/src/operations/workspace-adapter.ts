import type { Env } from '../env';
import { type JsonRpcResponse, jsonRpcSuccess, type McpTokenData } from '../routes/mcp/_helpers';
import { OperationError, operationErrorToWorkspaceJsonRpc } from './errors';
import { platformOperations } from './platform-operations';
import type { OperationContext } from './types';

const workspaceOperations: Record<string, (typeof platformOperations)[number]> = {
  get_task_details: platformOperations[0],
  list_tasks: platformOperations[1],
  search_tasks: platformOperations[1],
  get_session_messages: platformOperations[2],
  search_messages: platformOperations[3],
  list_ideas: platformOperations[4],
  search_ideas: platformOperations[4],
  find_related_ideas: platformOperations[4],
  get_idea: platformOperations[5],
  create_idea: platformOperations[6],
  update_idea: platformOperations[7],
  search_knowledge: platformOperations[8],
  list_agent_profiles: platformOperations[9],
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
