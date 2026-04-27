import type { AnthropicToolDef, CollectedToolCall, ToolContext } from '../types';
import { getProjectStatus, getProjectStatusDef } from './get-project-status';
import { listProjects, listProjectsDef } from './list-projects';
import { searchConversationHistory, searchConversationHistoryDef } from './search-conversation-history';
import { searchTasks, searchTasksDef } from './search-tasks';

/** All tool definitions in Anthropic native format. */
export const SAM_TOOLS: AnthropicToolDef[] = [
  listProjectsDef,
  getProjectStatusDef,
  searchTasksDef,
  searchConversationHistoryDef,
];

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  list_projects: listProjects as ToolHandler,
  get_project_status: getProjectStatus as ToolHandler,
  search_tasks: searchTasks as ToolHandler,
  search_conversation_history: searchConversationHistory as ToolHandler,
};

/** Execute a tool call and return the result (or error message on failure). */
export async function executeTool(
  toolCall: CollectedToolCall,
  ctx: ToolContext,
): Promise<unknown> {
  const handler = toolHandlers[toolCall.name];
  if (!handler) {
    return { error: `Unknown tool: ${toolCall.name}` };
  }
  try {
    return await handler(toolCall.input, ctx);
  } catch (err) {
    const message = err instanceof Error ? err.message : 'Tool execution failed';
    return { error: message };
  }
}
