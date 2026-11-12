/**
 * The environment the operations layer reads directly. The worker's `Env` extends it.
 *
 * Bindings and variables owned by other areas are not here: operations reach those through
 * `OperationPorts` (`./ports.ts`). Keep this list to what operations code itself reads.
 * Fields shared with the rest of the worker (`DATABASE`, search, mission and connector
 * limits) are also declared on the worker `Env`, with the same types.
 */
export interface OperationsEnv {
  DATABASE: D1Database;
  // Shared platform operation limits (`getPlatformOperationLimits`)
  MCP_TASK_LIST_LIMIT?: string; // Default task list page size (default: 10)
  MCP_TASK_LIST_MAX?: string; // Max task list page size (default: 50)
  MCP_TASK_SEARCH_LIMIT?: string; // Default task search page size (default: 10)
  MCP_TASK_SEARCH_MAX?: string; // Max task search page size (default: 20)
  MCP_TASK_DETAIL_RECENT_MESSAGE_LIMIT?: string; // Recent assistant messages in task detail (default: 5)
  MCP_TASK_DETAIL_MESSAGE_SNIPPET_LENGTH?: string; // Task detail assistant message snippet (default: 2000)
  MCP_MESSAGE_LIST_LIMIT?: string; // Default raw tokens per request (default: 50)
  MCP_MESSAGE_LIST_MAX?: string; // Max raw tokens per request (default: 200)
  MCP_MESSAGE_SEARCH_LIMIT?: string; // Default search_messages page size (default: 10)
  MCP_MESSAGE_SEARCH_MAX?: string; // Max search results for search_messages (default: 20)
  MCP_TASK_DESCRIPTION_SNIPPET_LENGTH?: string;
  MCP_IDEA_CONTENT_MAX_LENGTH?: string; // Max length for idea content/description (default: 65536)
  MCP_IDEA_LIST_LIMIT?: string; // Default page size for list_ideas (default: 20)
  MCP_IDEA_LIST_MAX?: string; // Max page size for list_ideas (default: 100)
  MCP_IDEA_SEARCH_MAX?: string; // Max results for search_ideas (default: 20)
  MCP_RELATED_IDEA_SEARCH_LIMIT?: string; // Default results for find_related_ideas (default: 10)
  MCP_IDEA_TITLE_MAX_LENGTH?: string; // Max length for idea title (default: 200)
  MCP_DISPATCH_MAX_PRIORITY?: string; // Max priority for agent-dispatched tasks (default: 100)
  KNOWLEDGE_SEARCH_LIMIT?: string; // Max search results (default: 20)
  /** Max UTF-8 bytes retained from idea/task/knowledge/message search input (default 4096, min 4). */
  SEARCH_QUERY_MAX_LENGTH?: string;
  /** Max LIKE-safe UTF-8 bytes retained per search term (default 48, min 4). */
  SEARCH_QUERY_MAX_TERM_LENGTH?: string;
  /** Max whitespace-delimited terms retained from search input (default 40; higher values clamp). */
  SEARCH_QUERY_MAX_TERMS?: string;
  CONNECTOR_INBOX_SESSION_LIMIT?: string;
  CONNECTOR_RESPONSE_MAX_BYTES?: string;
  CRON_TEMPLATE_MAX_LENGTH?: string; // Max prompt template length (default: 8000)
  MCP_ARCHIVED_TOOL_PAYLOAD_LIST_LIMIT?: string; // Default archived payloads per get_archived_tool_payloads (default: 10)
  MCP_ARCHIVED_TOOL_PAYLOAD_LIST_MAX?: string; // Max archived payloads per get_archived_tool_payloads (default: 50)
  MISSION_TITLE_MAX_LENGTH?: string;
  MISSION_DESCRIPTION_MAX_LENGTH?: string;
  MISSION_MAX_PER_PROJECT?: string;
}
