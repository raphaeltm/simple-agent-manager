/**
 * MCP tool definitions — the schema for all tools exposed via the MCP server.
 *
 * Extracted from _helpers.ts to keep file sizes manageable.
 */

export const MCP_TOOLS = [
  {
    name: 'get_instructions',
    description:
      'You MUST call this tool before starting any work. It provides your task context, project information, and instructions for reporting progress.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'update_task_status',
    description:
      'Report incremental progress on your current task. Call this when you complete a checklist item or reach a milestone.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        message: {
          type: 'string',
          description: 'Progress update message describing what was completed',
        },
      },
      required: ['message'],
      additionalProperties: false,
    },
  },
  {
    name: 'complete_task',
    description:
      'Mark the current task as completed. Call this after all work is done and changes are pushed.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished',
        },
      },
      additionalProperties: false,
    },
  },
  // ─── Task dispatch (agent-to-agent) ────────────────────────────────────
  {
    name: 'dispatch_task',
    description:
      'Dispatch a new task to another agent in the current project. Use this to spawn parallel work, delegate sub-tasks, or follow up on findings. The dispatched task runs independently in a new workspace. Rate-limited: max dispatch depth, per-task limit, and per-project active limit apply.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description: 'Task description — synthesize context from your conversation into a clear, actionable brief. Do NOT dump raw conversation history.',
        },
        vmSize: {
          type: 'string',
          description: 'VM size for the dispatched task (small, medium, large). Defaults to project default.',
          enum: ['small', 'medium', 'large'],
        },
        priority: {
          type: 'number',
          description: 'Task priority (0 = default). Higher values = higher priority.',
        },
        references: {
          type: 'array',
          items: { type: 'string' },
          description: 'File paths, spec references, or URLs to include as context for the dispatched agent.',
        },
        branch: {
          type: 'string',
          description: 'Git branch for the new workspace to check out. Defaults to the project\'s default branch (usually main). Only set this if you have already pushed the branch to the remote.',
        },
      },
      required: ['description'],
      additionalProperties: false,
    },
  },
  // ─── Agent-initiated notifications ──────────────────────────────────────
  {
    name: 'request_human_input',
    description:
      'Request human input when you are blocked, need a decision, need clarification, or need approval. ' +
      'This sends a high-urgency notification to the user and returns immediately — you can continue working or end your turn.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        context: {
          type: 'string',
          description: 'Explain what you need from the human — be specific about the decision, question, or blocker.',
        },
        category: {
          type: 'string',
          description: 'Category of input needed.',
          enum: ['decision', 'clarification', 'approval', 'error_help'],
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description: 'Optional list of choices for the human to pick from (e.g., ["Option A", "Option B"]).',
        },
      },
      required: ['context'],
      additionalProperties: false,
    },
  },
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
          description: 'Filter by task status (draft, queued, in_progress, delegated, awaiting_followup, completed, failed, cancelled). Omit for all statuses.',
          enum: ['draft', 'queued', 'in_progress', 'delegated', 'awaiting_followup', 'completed', 'failed', 'cancelled'],
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
      'Get full details of a specific task in your project, including its description, output summary, output branch, and PR URL.',
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
          enum: ['draft', 'queued', 'in_progress', 'delegated', 'awaiting_followup', 'completed', 'failed', 'cancelled'],
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
          description: 'Filter by message roles (default: ["user", "assistant"]). Use ["user", "assistant", "system", "tool", "thinking", "plan"] for all.',
        },
      },
      required: ['sessionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'search_messages',
    description:
      'Search messages across all chat sessions in your project by keyword using full-text search. Returns matching message snippets with session context. Useful for finding past discussions about specific topics, decisions, or code. Completed sessions use FTS5 indexing (matches messages containing all search words); active sessions fall back to keyword matching.',
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
  // ─── Session–Idea linking tools ──────────────────────────────────────
  {
    name: 'link_idea',
    description:
      'Associate the current chat session with an idea (task). Use this when the conversation touches on an existing idea. Linking is idempotent — linking the same idea twice is a no-op.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The idea (task) ID to link to the current session',
        },
        context: {
          type: 'string',
          description: 'Optional reasoning for why this session relates to the idea',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'unlink_idea',
    description:
      'Remove the association between the current chat session and an idea (task). No-op if the link does not exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The idea (task) ID to unlink from the current session',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_linked_ideas',
    description:
      'List all ideas (tasks) linked to the current chat session. Returns each idea with its title, status, link context, and when it was linked.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'find_related_ideas',
    description:
      'Search existing ideas in your project by keyword. Defaults to searching draft (idea) tasks only. Use this to find ideas that might relate to the current conversation before creating a new one.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in idea titles and descriptions',
        },
        status: {
          type: 'string',
          description: 'Filter by idea status. Omit for all statuses.',
          enum: ['draft', 'queued', 'in_progress', 'delegated', 'awaiting_followup', 'completed', 'failed', 'cancelled'],
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
  // ─── Idea management tools ───────────────────────────────────────────
  {
    name: 'create_idea',
    description:
      'Create a new idea in the current project. Ideas are lightweight notes for future consideration — they are NOT dispatched for execution. ' +
      'Use this to capture ideas, feature requests, or anything worth tracking. Returns the idea ID so you can link it to the current session via link_idea.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short title for the idea',
        },
        content: {
          type: 'string',
          description: 'Detailed content — supports checklists, notes, research findings, etc.',
        },
        priority: {
          type: 'number',
          description: 'Priority (0 = default). Higher = more important.',
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_idea',
    description:
      'Update an existing idea. By default, new content is appended to the existing content (great for adding notes from multiple conversations). Set append=false to replace content entirely.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ideaId: {
          type: 'string',
          description: 'The idea ID to update',
        },
        title: {
          type: 'string',
          description: 'New title (optional — only updates if provided)',
        },
        content: {
          type: 'string',
          description: 'Content to append (or replace if append=false)',
        },
        append: {
          type: 'boolean',
          description: 'If true (default), append content to existing description. If false, replace it.',
        },
        priority: {
          type: 'number',
          description: 'New priority (optional — only updates if provided)',
        },
      },
      required: ['ideaId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_idea',
    description:
      'Get full details of a specific idea, including its complete content. Use this to read the full text of an idea before updating it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        ideaId: {
          type: 'string',
          description: 'The idea ID to retrieve',
        },
      },
      required: ['ideaId'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_ideas',
    description:
      'List all ideas (draft tasks) in your project, ordered by most recently updated. Use this to see what ideas exist before creating duplicates.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        limit: {
          type: 'number',
          description: 'Max results to return',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_ideas',
    description:
      'Search ideas in your project by keyword. Searches both title and content fields. Only returns ideas (draft tasks), not executed tasks.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: {
          type: 'string',
          description: 'Search keyword to find in idea titles and content',
        },
        limit: {
          type: 'number',
          description: 'Max results to return',
        },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
];
