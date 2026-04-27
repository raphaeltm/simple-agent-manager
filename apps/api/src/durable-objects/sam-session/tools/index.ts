import type { AnthropicToolDef, CollectedToolCall, ToolContext } from '../types';
import { createMission, createMissionDef } from './create-mission';
import { dispatchTask, dispatchTaskDef } from './dispatch-task';
import { getMission, getMissionDef } from './get-mission';
import { getProjectStatus, getProjectStatusDef } from './get-project-status';
import { getTaskDetails, getTaskDetailsDef } from './get-task-details';
import { listProjects, listProjectsDef } from './list-projects';
import { searchConversationHistory, searchConversationHistoryDef } from './search-conversation-history';
import { searchTasks, searchTasksDef } from './search-tasks';

/** All tool definitions in Anthropic native format. */
export const SAM_TOOLS: AnthropicToolDef[] = [
  listProjectsDef,
  getProjectStatusDef,
  searchTasksDef,
  searchConversationHistoryDef,
  dispatchTaskDef,
  getTaskDetailsDef,
  createMissionDef,
  getMissionDef,
];

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

const toolHandlers: Record<string, ToolHandler> = {
  list_projects: listProjects as ToolHandler,
  get_project_status: getProjectStatus as ToolHandler,
  search_tasks: searchTasks as ToolHandler,
  search_conversation_history: searchConversationHistory as ToolHandler,
  dispatch_task: dispatchTask as unknown as ToolHandler,
  get_task_details: getTaskDetails as ToolHandler,
  create_mission: createMission as ToolHandler,
  get_mission: getMission as ToolHandler,
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
