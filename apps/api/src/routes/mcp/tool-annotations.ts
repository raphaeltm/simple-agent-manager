/**
 * MCP tool annotations for every listed tool. Harnesses use them to auto-approve safe
 * reads and to ask before risky actions, so they must be honest:
 *  - readOnlyHint: the tool changes nothing.
 *  - destructiveHint (writes only): the tool may remove, overwrite, cancel or stop
 *    existing work, or run arbitrary commands. Purely additive writes are false.
 *  - openWorldHint: the tool reaches beyond SAM (public network, email, external models).
 * Hints are advisory; every handler still enforces its own authorization.
 */
import type { McpToolGroup } from './tool-groups';

export interface McpToolAnnotations {
  readonly title?: string;
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly openWorldHint: boolean;
}

const READ_ONLY_TOOLS = new Set([
  'exec_with_secrets_status',
  'get_channel_history',
  'get_event',
  'get_handoff',
  'get_incident',
  'get_instructions',
  'get_mission',
  'get_mission_state',
  'get_orchestrator_status',
  'get_pending_messages',
  'get_project_event_subscription',
  'get_scheduling_queue',
  'get_workflow_run',
  'list_ai_models',
  'list_library_files',
  'list_channel_subscribers',
  'list_event_channels',
  'list_incident_queue',
  'list_project_event_subscriptions',
  'list_pull_request_associations',
  'list_subscription_events',
  'list_triggers',
  'ops_find_anomalies',
  'ops_get_access_status',
  'ops_get_node',
  'ops_get_node_log_capture',
  'ops_get_session_story',
  'ops_list_nodes',
  'ops_node_containers',
  'ops_node_events',
  'ops_node_logs',
  'ops_node_system_info',
  'ops_query_worker_logs',
  'ops_search_errors',
  'ops_timeline',
  'ops_why_is_node_alive',
  'ops_workspace_agent_sessions',
]);

const DESTRUCTIVE_TOOLS = new Set([
  'cancel_mission',
  'cancel_publish',
  'cancel_project_event_subscription',
  'complete_task',
  'delete_agent_profile',
  'delete_skill',
  'delete_trigger',
  // Writes into the workspace and may overwrite an existing file at the target path.
  'download_library_file',
  'exec_with_secrets',
  'exec_with_secrets_cancel',
  'ops_execute_action',
  'override_task_state',
  'pause_mission',
  'remove_pending_subtask',
  'replace_library_file',
  'stop_subtask',
  'update_trigger',
]);

const OPEN_WORLD_TOOLS = new Set([
  'deployments_write',
  'exec_with_secrets',
  'expose_port',
  'reply_to_email',
  'run_ai_model',
]);

export function annotationsForTool(name: string): McpToolAnnotations {
  if (READ_ONLY_TOOLS.has(name)) {
    return { readOnlyHint: true, openWorldHint: OPEN_WORLD_TOOLS.has(name) };
  }
  return {
    readOnlyHint: false,
    destructiveHint: DESTRUCTIVE_TOOLS.has(name),
    openWorldHint: OPEN_WORLD_TOOLS.has(name),
  };
}

export function annotationsForGroup(group: McpToolGroup): McpToolAnnotations {
  const openWorldHint = OPEN_WORLD_TOOLS.has(group.name);
  if (group.kind === 'read') return { readOnlyHint: true, openWorldHint };
  return { readOnlyHint: false, destructiveHint: group.destructive ?? true, openWorldHint };
}
