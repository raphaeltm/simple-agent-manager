/**
 * The catalogue agents see in `tools/list`: domain tool groups (`tool-groups.ts`) in
 * place of their member tools, plus every ungrouped tool, each with annotations.
 *
 * `MCP_TOOLS` remains the full set of callable tools. Group members are callable by
 * name but not listed, so sessions that cached an older `tools/list` keep working.
 */
import {
  annotationsForGroup,
  annotationsForTool,
  type McpToolAnnotations,
} from './tool-annotations';
import { MCP_TOOLS } from './tool-definitions';
import {
  buildGroupDefinition,
  indexGroupMembers,
  type McpToolDefinition,
} from './tool-group-schema';
import { MCP_TOOL_GROUPS } from './tool-groups';

export type ListedMcpTool = McpToolDefinition & { readonly annotations: McpToolAnnotations };

/**
 * Ungrouped tools whose handlers always reject a token without a task (`taskId === ''`:
 * direct workspace chats and trials). Hidden from those tokens' `tools/list`; the
 * handlers still enforce the check. Groups declare this with `requiresTask`.
 */
export const TASK_REQUIRED_TOOLS: ReadonlySet<string> = new Set([
  'ack_event_delivery',
  'associate_pull_request',
  'cancel_project_event_subscription',
  'catch_up_event_channel',
  'create_project_event_subscription',
  'follow_event_channel',
  'get_channel_history',
  'get_event',
  'get_project_event_subscription',
  'list_channel_subscribers',
  'list_event_channels',
  'list_project_event_subscriptions',
  'list_pull_request_associations',
  'list_subscription_events',
  'override_task_state',
  'publish_channel_event',
  'reply_to_email',
  'send_durable_message',
  'send_message_to_subtask',
  'stop_subtask',
  'wait_for_subtasks',
]);

const toolsByName = new Map<string, McpToolDefinition>(
  (MCP_TOOLS as readonly McpToolDefinition[]).map((tool) => [tool.name, tool])
);

export const GROUP_MEMBERS = indexGroupMembers(MCP_TOOL_GROUPS);

export const MCP_TOOL_GROUPS_BY_NAME = new Map(MCP_TOOL_GROUPS.map((group) => [group.name, group]));

const groupDefinitions: readonly ListedMcpTool[] = MCP_TOOL_GROUPS.map((group) => ({
  ...buildGroupDefinition(group, toolsByName),
  annotations: annotationsForGroup(group),
}));

const standaloneDefinitions: readonly ListedMcpTool[] = (MCP_TOOLS as readonly McpToolDefinition[])
  .filter((tool) => !GROUP_MEMBERS.has(tool.name))
  .map((tool) => ({ ...tool, annotations: annotationsForTool(tool.name) }));

/** Every listed tool: groups first, then ungrouped tools in definition order. */
export const LISTED_MCP_TOOLS: readonly ListedMcpTool[] = [
  ...groupDefinitions,
  ...standaloneDefinitions,
];

const TASK_REQUIRED_LISTED = new Set([
  ...TASK_REQUIRED_TOOLS,
  ...MCP_TOOL_GROUPS.filter((group) => group.requiresTask).map((group) => group.name),
]);

export function requiresTaskToken(listedName: string): boolean {
  return TASK_REQUIRED_LISTED.has(listedName);
}
