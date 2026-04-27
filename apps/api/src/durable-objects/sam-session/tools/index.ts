import type { AnthropicToolDef, CollectedToolCall, ToolContext } from '../types';
import { cancelMission, cancelMissionDef } from './cancel-mission';
import { createMission, createMissionDef } from './create-mission';
import { dispatchTask, dispatchTaskDef } from './dispatch-task';
import { getMission, getMissionDef } from './get-mission';
import { getProjectStatus, getProjectStatusDef } from './get-project-status';
import { getTaskDetails, getTaskDetailsDef } from './get-task-details';
import { listProjects, listProjectsDef } from './list-projects';
import { pauseMission, pauseMissionDef } from './pause-mission';
import { resumeMission, resumeMissionDef } from './resume-mission';
import { retrySubtask, retrySubtaskDef } from './retry-subtask';
import { searchConversationHistory, searchConversationHistoryDef } from './search-conversation-history';
import { searchTasks, searchTasksDef } from './search-tasks';
import { sendMessageToSubtask, sendMessageToSubtaskDef } from './send-message-to-subtask';
import { stopSubtask, stopSubtaskDef } from './stop-subtask';

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
  stopSubtaskDef,
  retrySubtaskDef,
  sendMessageToSubtaskDef,
  cancelMissionDef,
  pauseMissionDef,
  resumeMissionDef,
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
  stop_subtask: stopSubtask as ToolHandler,
  retry_subtask: retrySubtask as unknown as ToolHandler,
  send_message_to_subtask: sendMessageToSubtask as ToolHandler,
  cancel_mission: cancelMission as ToolHandler,
  pause_mission: pauseMission as ToolHandler,
  resume_mission: resumeMission as ToolHandler,
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
