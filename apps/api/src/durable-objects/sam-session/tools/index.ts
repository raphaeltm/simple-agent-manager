import type { AnthropicToolDef, CollectedToolCall, ToolContext } from '../types';
import { addKnowledge, addKnowledgeDef } from './add-knowledge';
import { addPolicy, addPolicyDef } from './add-policy';
import { cancelMission, cancelMissionDef } from './cancel-mission';
import { createIdea, createIdeaDef } from './create-idea';
import { createMission, createMissionDef } from './create-mission';
import { dispatchTask, dispatchTaskDef } from './dispatch-task';
import { findRelatedIdeas, findRelatedIdeasDef } from './find-related-ideas';
import { getCiStatus, getCiStatusDef } from './get-ci-status';
import { getFileContent, getFileContentDef } from './get-file-content';
import { getMission, getMissionDef } from './get-mission';
import { getOrchestratorStatus, getOrchestratorStatusDef } from './get-orchestrator-status';
import { getProjectKnowledge, getProjectKnowledgeDef } from './get-project-knowledge';
import { getProjectStatus, getProjectStatusDef } from './get-project-status';
import { getSessionMessages, getSessionMessagesDef } from './get-session-messages';
import { getTaskDetails, getTaskDetailsDef } from './get-task-details';
import { listIdeas, listIdeasDef } from './list-ideas';
import { listPolicies, listPoliciesDef } from './list-policies';
import { listProjects, listProjectsDef } from './list-projects';
import { listSessions, listSessionsDef } from './list-sessions';
import { pauseMission, pauseMissionDef } from './pause-mission';
import { resumeMission, resumeMissionDef } from './resume-mission';
import { retrySubtask, retrySubtaskDef } from './retry-subtask';
import { searchCode, searchCodeDef } from './search-code';
import { searchConversationHistory, searchConversationHistoryDef } from './search-conversation-history';
import { searchKnowledge, searchKnowledgeDef } from './search-knowledge';
import { searchTaskMessages, searchTaskMessagesDef } from './search-task-messages';
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
  createIdeaDef,
  listIdeasDef,
  findRelatedIdeasDef,
  getCiStatusDef,
  getOrchestratorStatusDef,
  searchKnowledgeDef,
  getProjectKnowledgeDef,
  addKnowledgeDef,
  listPoliciesDef,
  addPolicyDef,
  // Observability: task message search
  listSessionsDef,
  getSessionMessagesDef,
  searchTaskMessagesDef,
  // Codebase contextual search
  searchCodeDef,
  getFileContentDef,
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
  create_idea: createIdea as ToolHandler,
  list_ideas: listIdeas as ToolHandler,
  find_related_ideas: findRelatedIdeas as ToolHandler,
  get_ci_status: getCiStatus as ToolHandler,
  get_orchestrator_status: getOrchestratorStatus as ToolHandler,
  search_knowledge: searchKnowledge as ToolHandler,
  get_project_knowledge: getProjectKnowledge as ToolHandler,
  add_knowledge: addKnowledge as ToolHandler,
  list_policies: listPolicies as ToolHandler,
  add_policy: addPolicy as ToolHandler,
  // Observability: task message search
  list_sessions: listSessions as ToolHandler,
  get_session_messages: getSessionMessages as ToolHandler,
  search_task_messages: searchTaskMessages as ToolHandler,
  // Codebase contextual search
  search_code: searchCode as ToolHandler,
  get_file_content: getFileContent as ToolHandler,
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
