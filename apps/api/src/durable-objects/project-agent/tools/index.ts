/**
 * Project Agent tool registry — project-scoped subset of SAM tools.
 *
 * Unlike SAM tools where projectId is a required input parameter, project agent
 * tools automatically inject projectId from the ToolContext. Tool definitions omit
 * projectId from their input schemas; handlers inject it before calling the
 * underlying SAM tool handler.
 */
// Import SAM tool handlers
import { addKnowledge } from '../../sam-session/tools/add-knowledge';
// Import SAM tool definitions
import { addKnowledgeDef } from '../../sam-session/tools/add-knowledge';
import { addPolicy } from '../../sam-session/tools/add-policy';
import { addPolicyDef } from '../../sam-session/tools/add-policy';
import { cancelMission } from '../../sam-session/tools/cancel-mission';
import { cancelMissionDef } from '../../sam-session/tools/cancel-mission';
import { createIdea } from '../../sam-session/tools/create-idea';
import { createIdeaDef } from '../../sam-session/tools/create-idea';
import { createMission } from '../../sam-session/tools/create-mission';
import { createMissionDef } from '../../sam-session/tools/create-mission';
import { dispatchTask } from '../../sam-session/tools/dispatch-task';
import { dispatchTaskDef } from '../../sam-session/tools/dispatch-task';
import { findRelatedIdeas } from '../../sam-session/tools/find-related-ideas';
import { findRelatedIdeasDef } from '../../sam-session/tools/find-related-ideas';
import { getCiStatus } from '../../sam-session/tools/get-ci-status';
import { getCiStatusDef } from '../../sam-session/tools/get-ci-status';
import { getFileContent } from '../../sam-session/tools/get-file-content';
import { getFileContentDef } from '../../sam-session/tools/get-file-content';
import { getMission } from '../../sam-session/tools/get-mission';
import { getMissionDef } from '../../sam-session/tools/get-mission';
import { getOrchestratorStatus } from '../../sam-session/tools/get-orchestrator-status';
import { getOrchestratorStatusDef } from '../../sam-session/tools/get-orchestrator-status';
import { getProjectKnowledge } from '../../sam-session/tools/get-project-knowledge';
import { getProjectKnowledgeDef } from '../../sam-session/tools/get-project-knowledge';
import { getSessionMessages } from '../../sam-session/tools/get-session-messages';
import { getSessionMessagesDef } from '../../sam-session/tools/get-session-messages';
import { getTaskDetails } from '../../sam-session/tools/get-task-details';
import { getTaskDetailsDef } from '../../sam-session/tools/get-task-details';
import { listIdeas } from '../../sam-session/tools/list-ideas';
import { listIdeasDef } from '../../sam-session/tools/list-ideas';
import { listPolicies } from '../../sam-session/tools/list-policies';
import { listPoliciesDef } from '../../sam-session/tools/list-policies';
import { listSessions } from '../../sam-session/tools/list-sessions';
import { listSessionsDef } from '../../sam-session/tools/list-sessions';
import { pauseMission } from '../../sam-session/tools/pause-mission';
import { pauseMissionDef } from '../../sam-session/tools/pause-mission';
import { resumeMission } from '../../sam-session/tools/resume-mission';
import { resumeMissionDef } from '../../sam-session/tools/resume-mission';
import { retrySubtask } from '../../sam-session/tools/retry-subtask';
import { retrySubtaskDef } from '../../sam-session/tools/retry-subtask';
import { searchCode } from '../../sam-session/tools/search-code';
import { searchCodeDef } from '../../sam-session/tools/search-code';
import { searchConversationHistory } from '../../sam-session/tools/search-conversation-history';
import { searchConversationHistoryDef } from '../../sam-session/tools/search-conversation-history';
import { searchKnowledge } from '../../sam-session/tools/search-knowledge';
import { searchKnowledgeDef } from '../../sam-session/tools/search-knowledge';
import { searchTaskMessages } from '../../sam-session/tools/search-task-messages';
import { searchTaskMessagesDef } from '../../sam-session/tools/search-task-messages';
import { searchTasks } from '../../sam-session/tools/search-tasks';
import { searchTasksDef } from '../../sam-session/tools/search-tasks';
import { sendMessageToSubtask } from '../../sam-session/tools/send-message-to-subtask';
import { sendMessageToSubtaskDef } from '../../sam-session/tools/send-message-to-subtask';
import { stopSubtask } from '../../sam-session/tools/stop-subtask';
import { stopSubtaskDef } from '../../sam-session/tools/stop-subtask';
import type { AnthropicToolDef, CollectedToolCall, ToolContext } from '../../sam-session/types';

// =============================================================================
// Helper: strip projectId from a tool definition's input schema
// =============================================================================

function stripProjectId(def: AnthropicToolDef): AnthropicToolDef {
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const { projectId: _stripped, ...remainingProps } = def.input_schema.properties;
  const required = (def.input_schema.required || []).filter((r) => r !== 'projectId');
  return {
    ...def,
    input_schema: {
      type: 'object',
      properties: remainingProps,
      ...(required.length > 0 ? { required } : {}),
    },
  };
}

// =============================================================================
// Project-scoped tool definitions (projectId stripped from input schemas)
// =============================================================================

/** All project agent tool definitions in Anthropic native format. */
export const PROJECT_AGENT_TOOLS: AnthropicToolDef[] = [
  // Knowledge graph
  stripProjectId(searchKnowledgeDef),
  stripProjectId(getProjectKnowledgeDef),
  stripProjectId(addKnowledgeDef),
  // Policies
  stripProjectId(addPolicyDef),
  stripProjectId(listPoliciesDef),
  // Tasks & execution
  stripProjectId(dispatchTaskDef),
  stripProjectId(searchTasksDef),
  getTaskDetailsDef,
  stripProjectId(stopSubtaskDef),
  stripProjectId(retrySubtaskDef),
  stripProjectId(sendMessageToSubtaskDef),
  // Sessions & messages
  stripProjectId(listSessionsDef),
  stripProjectId(getSessionMessagesDef),
  stripProjectId(searchTaskMessagesDef),
  // Ideas
  stripProjectId(createIdeaDef),
  stripProjectId(listIdeasDef),
  stripProjectId(findRelatedIdeasDef),
  // Missions & orchestration
  stripProjectId(createMissionDef),
  stripProjectId(getMissionDef),
  stripProjectId(pauseMissionDef),
  stripProjectId(resumeMissionDef),
  stripProjectId(cancelMissionDef),
  stripProjectId(getOrchestratorStatusDef),
  // Codebase
  stripProjectId(searchCodeDef),
  stripProjectId(getFileContentDef),
  // Monitoring
  stripProjectId(getCiStatusDef),
  // Conversation memory
  searchConversationHistoryDef,
];

// =============================================================================
// Tool handler map — injects projectId from context
// =============================================================================

type ToolHandler = (input: Record<string, unknown>, ctx: ToolContext) => Promise<unknown>;

/** Wrap a SAM tool handler so that projectId is injected from ctx.projectId. */
function withProjectId(handler: ToolHandler): ToolHandler {
  return async (input, ctx) => {
    if (!ctx.projectId) {
      return { error: 'Project agent context missing projectId.' };
    }
    return handler({ ...input, projectId: ctx.projectId }, ctx);
  };
}

const toolHandlers: Record<string, ToolHandler> = {
  // Knowledge
  search_knowledge: withProjectId(searchKnowledge as ToolHandler),
  get_project_knowledge: withProjectId(getProjectKnowledge as ToolHandler),
  add_knowledge: withProjectId(addKnowledge as ToolHandler),
  // Policies
  add_policy: withProjectId(addPolicy as ToolHandler),
  list_policies: withProjectId(listPolicies as ToolHandler),
  // Tasks
  dispatch_task: withProjectId(dispatchTask as unknown as ToolHandler),
  search_tasks: withProjectId(searchTasks as ToolHandler),
  get_task_details: getTaskDetails as ToolHandler,
  stop_subtask: withProjectId(stopSubtask as ToolHandler),
  retry_subtask: withProjectId(retrySubtask as unknown as ToolHandler),
  send_message_to_subtask: withProjectId(sendMessageToSubtask as ToolHandler),
  // Sessions
  list_sessions: withProjectId(listSessions as ToolHandler),
  get_session_messages: withProjectId(getSessionMessages as ToolHandler),
  search_task_messages: withProjectId(searchTaskMessages as ToolHandler),
  // Ideas
  create_idea: withProjectId(createIdea as ToolHandler),
  list_ideas: withProjectId(listIdeas as ToolHandler),
  find_related_ideas: withProjectId(findRelatedIdeas as ToolHandler),
  // Missions
  create_mission: withProjectId(createMission as ToolHandler),
  get_mission: withProjectId(getMission as ToolHandler),
  pause_mission: withProjectId(pauseMission as ToolHandler),
  resume_mission: withProjectId(resumeMission as ToolHandler),
  cancel_mission: withProjectId(cancelMission as ToolHandler),
  get_orchestrator_status: withProjectId(getOrchestratorStatus as ToolHandler),
  // Codebase
  search_code: withProjectId(searchCode as ToolHandler),
  get_file_content: withProjectId(getFileContent as ToolHandler),
  // Monitoring
  get_ci_status: withProjectId(getCiStatus as ToolHandler),
  // Conversation memory
  search_conversation_history: searchConversationHistory as ToolHandler,
};

/** Execute a tool call and return the result (or error message on failure). */
export async function executeProjectTool(
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
