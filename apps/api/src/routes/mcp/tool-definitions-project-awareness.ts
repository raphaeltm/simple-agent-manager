/**
 * MCP tool definitions — project awareness tools (read-only queries for tasks, sessions, messages).
 */

export const PROJECT_AWARENESS_TOOLS = [
  // ─── Project awareness tools (read-only) ──────────────────────────────
  {
    name: 'list_tasks',
    description:
      'List tasks in your project. Useful for understanding what other work exists, avoiding duplicates, or finding context from completed tasks. Your own task is excluded by default.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description:
            'Filter by task status (draft, queued, in_progress, delegated, awaiting_followup, completed, failed, cancelled). Omit for all statuses.',
          enum: [
            'draft',
            'queued',
            'in_progress',
            'delegated',
            'awaiting_followup',
            'completed',
            'failed',
            'cancelled',
          ],
        },
        include_own: {
          type: 'boolean',
          description: 'Include your own task in the results (default: false)',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 50)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_details',
    description:
      'Get full details of a specific task in your project, including its description, output summary, output branch, PR URL, structured completion evidence, and the chat sessionId once the session exists (Instant dispatches create it asynchronously).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID to retrieve',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_tasks',
    description:
      'Search tasks in your project by keyword. Searches both title and description fields.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in task titles and descriptions',
        },
        status: {
          type: 'string',
          description: 'Filter by task status. Omit for all statuses.',
          enum: [
            'draft',
            'queued',
            'in_progress',
            'delegated',
            'awaiting_followup',
            'completed',
            'failed',
            'cancelled',
          ],
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 20)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_sessions',
    description:
      'List chat sessions in your project. Each session represents a conversation between a user and an agent. Sessions may be linked to tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        status: {
          type: 'string',
          description: 'Filter by session status (active, stopped). Omit for all.',
          enum: ['active', 'stopped'],
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 50)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_session_messages',
    description:
      'Read messages from a specific chat session. Returns logical messages in chronological order (consecutive streaming tokens with the same role are concatenated for assistant, tool, and thinking roles; user/system/plan messages pass through as-is). The `limit` parameter controls how many raw tokens are fetched before grouping, so the returned message count may be fewer than `limit`. `hasMore` indicates whether additional raw tokens exist beyond the fetched window. By default only returns user and assistant messages (skips tool calls and system messages).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'The session ID to read messages from',
        },
        limit: {
          type: 'number',
          description: 'Max messages to return (default: 50, max: 200)',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Filter by message roles (default: ["user", "assistant"]). Use ["user", "assistant", "system", "tool", "thinking", "plan"] for all.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_archived_tool_payloads',
    description:
      'Retrieve ProjectData tool-call JSON payloads that were archived from Durable Object SQLite to private R2. Scope is the current project. Provide a messageId, a sessionId, and/or a message-created time range to keep the read bounded.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        messageId: {
          type: 'string',
          description: 'Optional exact tool message ID to retrieve.',
        },
        sessionId: {
          type: 'string',
          description: 'Optional session ID to retrieve archived tool payloads from.',
        },
        startTime: {
          type: ['number', 'string'],
          description:
            'Optional inclusive lower bound for message created time, as epoch milliseconds or an ISO timestamp.',
        },
        endTime: {
          type: ['number', 'string'],
          description:
            'Optional inclusive upper bound for message created time, as epoch milliseconds or an ISO timestamp.',
        },
        limit: {
          type: 'number',
          description: 'Max archived payloads to return (default: 10, max: 50).',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_resource_history',
    description:
      'Inspect bounded workspace resource history for the current project. By default, MCP callers read their current session/task/workspace summary and chunk index. Pass sessionId, taskId, or workspaceId to inspect a related scope. Pass chunkId to lazily load downsampled raw samples and tool-span correlation for that chunk. This reports correlation, not causal per-process attribution, and never includes prompts, commands, tool args/output, file paths, env, or secrets.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sessionId: {
          type: 'string',
          description: 'Optional session scope. Defaults to the caller session when available.',
        },
        taskId: {
          type: 'string',
          description: 'Optional task scope. Defaults to the caller task when available.',
        },
        workspaceId: {
          type: 'string',
          description: 'Optional workspace scope. Defaults to the caller workspace when available.',
        },
        chunkId: {
          type: 'string',
          description:
            'Optional resource chunk ID to load detailed downsampled samples/tool spans.',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description:
      'Search messages across all chat sessions in your project by keyword using full-text search. Returns matching message snippets with session context. Useful for finding past discussions about specific topics, decisions, or code. Sessions are indexed incrementally each time they sleep or stop, so sleeping and stopped sessions are covered by FTS5 (matches messages containing all search words); only messages written since a session was last indexed fall back to keyword matching. To keep large projects responsive, relevance ranking considers the newest matches (a configured window) and the keyword fallback scans only the newest raw messages; when either bound was reached, the rootSearch field flags it and coverageNotes explains what was not searched, so an empty result then does not prove absence.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in message content',
        },
        sessionId: {
          type: 'string',
          description: 'Narrow search to a specific session (optional)',
        },
        roles: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter by message roles (default: ["user", "assistant"])',
        },
        limit: {
          type: 'number',
          description: 'Max results to return (default: 10, max: 20)',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
