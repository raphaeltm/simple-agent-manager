/**
 * Table of MCP tools whose call is a plain `(requestId, args, tokenData, env)` handler.
 * Tools that need the Hono context or a custom response live in the switch in `index.ts`.
 */
import type { Env } from '../../env';
import type { JsonRpcResponse, McpTokenData } from './_helpers';
import { handleReplyToEmail } from './agent-email-tools';
import { handleListAiModels, handleRunAiModel } from './agent-model-tools';
import { handleBuildAndPublish, handleGetPublishStatus } from './compose-publish-tools';
import { handleListDeploymentRoutes, handleReadDeploymentLogs } from './deployment-tools';
import {
  handleCreateIdea,
  handleFindRelatedIdeas,
  handleGetIdea,
  handleLinkIdea,
  handleListIdeas,
  handleListLinkedIdeas,
  handleSearchIdeas,
  handleUnlinkIdea,
  handleUpdateIdea,
} from './idea-tools';
import {
  handleClaimIncident,
  handleGetIncident,
  handleListIncidentQueue,
  handleResolveIncident,
} from './incident-tools';
import { handleRequestHumanInput } from './instruction-tools';
import {
  handleAddKnowledge,
  handleConfirmKnowledge,
  handleFlagContradiction,
  handleGetKnowledge,
  handleGetProjectKnowledge,
  handleGetRelated,
  handleGetRelevantKnowledge,
  handleRelateKnowledge,
  handleRemoveKnowledge,
  handleSearchKnowledge,
  handleUpdateKnowledge,
} from './knowledge-tools';
import {
  handleDisplayFromLibrary,
  handleDownloadLibraryFile,
  handleListLibraryFiles,
  handleReplaceLibraryFile,
  handleUploadToLibrary,
} from './library-tools';
import {
  handleAckMessage,
  handleGetPendingMessages,
  handleSendDurableMessage,
} from './mailbox-tools';
import {
  handleCreateMission,
  handleGetHandoff,
  handleGetMission,
  handleGetMissionState,
  handlePublishHandoff,
  handlePublishMissionState,
} from './mission-tools';
import { handleSendMessageToSubtask, handleStopSubtask } from './orchestration-comms';
import {
  handleAddDependency,
  handleRemovePendingSubtask,
  handleRetrySubtask,
} from './orchestration-tools';
import {
  handleGetOrchestratorStatus,
  handleGetSchedulingQueue,
  handleOverrideTaskState,
} from './orchestrator-lifecycle-tools';
import {
  handleCancelMission as handleCancelMissionOrch,
  handlePauseMission as handlePauseMissionOrch,
  handleResumeMission as handleResumeMissionOrch,
} from './orchestrator-lifecycle-tools';
import {
  handleAddPolicy,
  handleGetPolicy,
  handleListPolicies,
  handleRemovePolicy,
  handleUpdatePolicy,
} from './policy-tools';
import {
  handleAddProfileEnvVar,
  handleCreateAgentProfile,
  handleDeleteAgentProfile,
  handleGetAgentProfile,
  handleListAgentProfiles,
  handleListProfileEnvVars,
  handleRemoveProfileEnvVar,
  handleUpdateAgentProfile,
} from './profile-tools';
import { handleAckEventDelivery, handleGetEvent } from './project-event-tools';
import {
  handleGetResourceHistory,
  handleGetSessionMessages,
  handleListSessions,
  handleSearchMessages,
  handleUpdateSessionTopic,
} from './session-tools';
import {
  handleCreateSkill,
  handleDeleteSkill,
  handleGetSkill,
  handleListSkills,
  handleUpdateSkill,
} from './skill-tools';
import {
  handleGetTaskDetails,
  handleListTasks,
  handleSearchTasks,
  handleUpdateTaskStatus,
} from './task-tools';
import { handleWaitForSubtasks } from './task-wait-tools';
import {
  handleCreateTrigger,
  handleDeleteTrigger,
  handleListTriggers,
  handleUpdateTrigger,
} from './trigger-tools';
import { handleGetWorkflowRun, handleStartWorkflowRun } from './workflow-tools';
import { handleExposePort } from './workspace-tools';
import { handleGetCredentialLimits } from './workspace-tools-credential-limits';
import { handleGetPeerAgentOutput, handleListProjectAgents } from './workspace-tools-direct';

export type McpToolHandler = (
  requestId: string | number | null,
  args: Record<string, unknown>,
  tokenData: McpTokenData,
  env: Env
) => Promise<JsonRpcResponse>;

export const MCP_TOOL_HANDLERS: ReadonlyMap<string, McpToolHandler> = new Map<
  string,
  McpToolHandler
>([
  ['list_ai_models', handleListAiModels],
  ['run_ai_model', handleRunAiModel],
  ['update_task_status', handleUpdateTaskStatus],
  ['request_human_input', handleRequestHumanInput],
  ['wait_for_subtasks', handleWaitForSubtasks],
  ['get_event', handleGetEvent],
  ['ack_event_delivery', handleAckEventDelivery],
  ['send_durable_message', handleSendDurableMessage],
  ['get_pending_messages', handleGetPendingMessages],
  ['ack_message', handleAckMessage],
  ['send_message_to_subtask', handleSendMessageToSubtask],
  ['stop_subtask', handleStopSubtask],
  ['retry_subtask', handleRetrySubtask],
  ['add_dependency', handleAddDependency],
  ['remove_pending_subtask', handleRemovePendingSubtask],
  ['list_tasks', handleListTasks],
  ['get_task_details', handleGetTaskDetails],
  ['search_tasks', handleSearchTasks],
  ['list_sessions', handleListSessions],
  ['get_session_messages', handleGetSessionMessages],
  ['get_resource_history', handleGetResourceHistory],
  ['search_messages', handleSearchMessages],
  ['update_session_topic', handleUpdateSessionTopic],
  ['reply_to_email', handleReplyToEmail],
  ['link_idea', handleLinkIdea],
  ['unlink_idea', handleUnlinkIdea],
  ['list_linked_ideas', handleListLinkedIdeas],
  ['find_related_ideas', handleFindRelatedIdeas],
  ['create_idea', handleCreateIdea],
  ['update_idea', handleUpdateIdea],
  ['get_idea', handleGetIdea],
  ['list_ideas', handleListIdeas],
  ['search_ideas', handleSearchIdeas],
  ['build_and_publish', handleBuildAndPublish],
  ['get_publish_status', handleGetPublishStatus],
  ['read_deployment_logs', handleReadDeploymentLogs],
  ['list_deployment_routes', handleListDeploymentRoutes],
  ['get_credential_limits', handleGetCredentialLimits],
  ['expose_port', handleExposePort],
  ['list_project_agents', handleListProjectAgents],
  ['get_peer_agent_output', handleGetPeerAgentOutput],
  ['list_library_files', handleListLibraryFiles],
  ['download_library_file', handleDownloadLibraryFile],
  ['upload_to_library', handleUploadToLibrary],
  ['replace_library_file', handleReplaceLibraryFile],
  ['display_from_library', handleDisplayFromLibrary],
  ['list_triggers', handleListTriggers],
  ['create_trigger', handleCreateTrigger],
  ['update_trigger', handleUpdateTrigger],
  ['delete_trigger', handleDeleteTrigger],
  ['list_incident_queue', handleListIncidentQueue],
  ['get_incident', handleGetIncident],
  ['claim_incident', handleClaimIncident],
  ['resolve_incident', handleResolveIncident],
  ['list_agent_profiles', handleListAgentProfiles],
  ['get_agent_profile', handleGetAgentProfile],
  ['create_agent_profile', handleCreateAgentProfile],
  ['update_agent_profile', handleUpdateAgentProfile],
  ['delete_agent_profile', handleDeleteAgentProfile],
  ['add_profile_env_var', handleAddProfileEnvVar],
  ['remove_profile_env_var', handleRemoveProfileEnvVar],
  ['list_profile_env_vars', handleListProfileEnvVars],
  ['list_skills', handleListSkills],
  ['get_skill', handleGetSkill],
  ['create_skill', handleCreateSkill],
  ['update_skill', handleUpdateSkill],
  ['delete_skill', handleDeleteSkill],
  ['add_knowledge', handleAddKnowledge],
  ['update_knowledge', handleUpdateKnowledge],
  ['remove_knowledge', handleRemoveKnowledge],
  ['get_knowledge', handleGetKnowledge],
  ['search_knowledge', handleSearchKnowledge],
  ['get_project_knowledge', handleGetProjectKnowledge],
  ['get_relevant_knowledge', handleGetRelevantKnowledge],
  ['relate_knowledge', handleRelateKnowledge],
  ['get_related', handleGetRelated],
  ['confirm_knowledge', handleConfirmKnowledge],
  ['flag_contradiction', handleFlagContradiction],
  ['start_workflow_run', handleStartWorkflowRun],
  ['get_workflow_run', handleGetWorkflowRun],
  ['create_mission', handleCreateMission],
  ['get_mission', handleGetMission],
  ['publish_mission_state', handlePublishMissionState],
  ['get_mission_state', handleGetMissionState],
  ['publish_handoff', handlePublishHandoff],
  ['get_handoff', handleGetHandoff],
  ['get_orchestrator_status', handleGetOrchestratorStatus],
  ['get_scheduling_queue', handleGetSchedulingQueue],
  ['pause_mission', handlePauseMissionOrch],
  ['resume_mission', handleResumeMissionOrch],
  ['cancel_mission', handleCancelMissionOrch],
  ['override_task_state', handleOverrideTaskState],
  ['add_policy', handleAddPolicy],
  ['list_policies', handleListPolicies],
  ['get_policy', handleGetPolicy],
  ['update_policy', handleUpdatePolicy],
  ['remove_policy', handleRemovePolicy],
]);
