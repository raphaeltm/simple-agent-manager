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
  // ─── Session management tools ───────────────────────────────────────
  {
    name: 'update_session_topic',
    description:
      'Update the topic (title) of your current chat session. Use this when you understand the conversation\'s true subject after a few messages, ' +
      'or when the conversation changes direction. The topic is displayed in the session list and helps users identify what each session is about.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        topic: {
          type: 'string',
          description: 'New topic/title for the session. Should be concise and descriptive.',
        },
      },
      required: ['topic'],
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
        status: {
          type: 'string',
          description:
            'Transition the idea to a new status. Allowed transitions: draft→ready, draft→cancelled, ready→draft, ready→completed, ready→cancelled. Terminal statuses (completed, cancelled) cannot be changed.',
          enum: ['draft', 'ready', 'completed', 'cancelled'],
        },
      },
      required: ['ideaId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_idea',
    description:
      'Get full details of a specific idea, including its complete content. Works for ideas in any status.',
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
  {
    name: 'get_deployment_credentials',
    description:
      'Get GCP deployment credentials for the current project. Returns a GCP external_account credential config JSON that can be written to a file and used with GOOGLE_APPLICATION_CREDENTIALS. GCP client libraries will auto-refresh tokens via SAM.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  // ─── Workspace tools (unified from workspace-mcp) ──────────────────────
  {
    name: 'get_workspace_info',
    description:
      'Get consolidated workspace metadata: ID, node, project, branch, mode, VM size, URL, uptime. Use this for orientation at the start of a session.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_credential_status',
    description:
      'Check which credentials are available in the workspace (GitHub token, API key, OAuth token, MCP token). Returns presence/absence only — never actual values.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_network_info',
    description:
      'Get workspace network info: base domain, workspace URL, and all listening ports with their external URLs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'expose_port',
    description:
      'Register a port and get its external URL. Use after starting a dev server to get the public URL for testing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        port: {
          type: 'number',
          description: 'Port number to expose (1-65535)',
        },
        label: {
          type: 'string',
          description: 'Optional human-readable label for the port (e.g., "Vite dev server")',
        },
      },
      required: ['port'],
      additionalProperties: false,
    },
  },
  {
    name: 'check_dns_status',
    description:
      'Check DNS propagation and TLS certificate validity for this workspace URL. Useful after workspace creation to verify accessibility.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'check_cost_estimate',
    description:
      'Get VM hourly rate, runtime duration, and estimated total cost for this workspace session.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_remaining_budget',
    description:
      'Get remaining project cost budget. Budget tracking is not yet implemented — always returns null values. Will return budget, spent, and remaining amounts once configured.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'list_project_agents',
    description:
      'List all active agent sessions in this project (excluding yourself). Shows task IDs, titles, statuses, and branches. Useful for multi-agent coordination.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_peer_agent_output',
    description:
      'Retrieve the result/summary from a sibling task agent by task ID. Use this to check what another agent accomplished.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'Task ID of the peer agent to query',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_task_dependencies',
    description:
      'Get the upstream/downstream task dependency graph for the current task. Shows parent, children, and sibling tasks with their statuses.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_ci_status',
    description:
      'Get GitHub Actions workflow status for the current branch. Returns overall status and individual workflow run details.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_deployment_status',
    description:
      'Get staging and production deployment state: last deploy status, whether a deploy is currently running, and recent deployment runs.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_workspace_diff_summary',
    description:
      'Get all changes since workspace creation: files changed, new, deleted, commit count, diff stats, and untracked files.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'report_environment_issue',
    description:
      'Report a structured environment issue to the observability dashboard. Use when you encounter workspace problems (network, credentials, disk, performance).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Issue category (e.g., "network", "credentials", "disk", "performance")',
        },
        severity: {
          type: 'string',
          description: 'Issue severity level',
          enum: ['low', 'medium', 'high', 'critical'],
        },
        description: {
          type: 'string',
          description: 'Detailed description of the issue',
        },
        diagnosticData: {
          type: 'object',
          description: 'Optional additional key-value diagnostic data',
        },
      },
      required: ['category', 'severity', 'description'],
      additionalProperties: false,
    },
  },
  // ─── Onboarding tools ──────────────────────────────────────────────────
  {
    name: 'get_repo_setup_guide',
    description:
      'Get a comprehensive guide for preparing this repository for SAM-aware agent workflows. ' +
      'Returns a detailed briefing covering SAM environment detection, MCP tools, workflow patterns, ' +
      'and step-by-step instructions for analyzing the repo and updating agent configuration files. ' +
      'Call this when onboarding a new repository to SAM.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  // ─── Project file library tools ──────────────────────────────────────
  {
    name: 'list_library_files',
    description:
      'Browse your project\'s file library. Returns file metadata (not content) so you can decide what to download. ' +
      'Supports filtering by tags, file type (MIME prefix), and upload source.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Filter to files that have ALL specified tags (AND logic)',
        },
        fileType: {
          type: 'string',
          description: 'Filter by MIME type prefix (e.g., "image/", "text/", "application/json")',
        },
        source: {
          type: 'string',
          description: 'Filter by who uploaded the file',
          enum: ['user', 'agent'],
        },
        sortBy: {
          type: 'string',
          description: 'Sort field (default: createdAt)',
          enum: ['createdAt', 'filename', 'sizeBytes'],
        },
        limit: {
          type: 'number',
          description: 'Max files to return (default: 50, max: 200)',
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'download_library_file',
    description:
      'Download a file from the project library into the workspace. The file is decrypted and placed in the configured library directory ' +
      '(default: .library/, configurable via LIBRARY_MCP_DOWNLOAD_DIR). Use list_library_files first to find the file ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileId: {
          type: 'string',
          description: 'The file ID to download (from list_library_files)',
        },
        targetPath: {
          type: 'string',
          description: 'Custom path within the workspace to place the file (default: .library/<filename>)',
        },
      },
      required: ['fileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'upload_to_library',
    description:
      'Upload a file from the workspace to the project library. The file is encrypted and stored permanently. ' +
      'Fails with FILE_EXISTS error if a file with the same filename already exists — use replace_library_file to update it.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        filePath: {
          type: 'string',
          description: 'Path to the file in the workspace to upload',
        },
        description: {
          type: 'string',
          description: 'Optional description of the file contents or purpose',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Tags to apply to the file (lowercase alphanumeric with hyphens)',
        },
      },
      required: ['filePath'],
      additionalProperties: false,
    },
  },
  {
    name: 'replace_library_file',
    description:
      'Replace the content of an existing library file with a new version from the workspace. Requires the file ID (not filename). ' +
      'New tags are merged with existing tags. Original upload provenance is preserved.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        fileId: {
          type: 'string',
          description: 'The file ID to replace (from list_library_files or upload_to_library FILE_EXISTS error)',
        },
        filePath: {
          type: 'string',
          description: 'Path to the new file in the workspace',
        },
        description: {
          type: 'string',
          description: 'Optional updated description',
        },
        tags: {
          type: 'array',
          items: { type: 'string' },
          description: 'Additional tags to merge with existing tags',
        },
      },
      required: ['fileId', 'filePath'],
      additionalProperties: false,
    },
  },
  // ─── Orchestration tools (agent-to-agent communication & control) ───
  {
    name: 'send_message_to_subtask',
    description:
      'Send a message to a running child task\'s agent. The message is injected as a user-role prompt into the child\'s ACP session. ' +
      'Only the direct parent task can message a child — grandparents and siblings are rejected. ' +
      'Returns { delivered: true } on success, or { delivered: false, reason: "agent_busy" } if the child agent is currently processing.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The child task ID to send the message to',
        },
        message: {
          type: 'string',
          description: 'The message to inject into the child agent\'s session (max 32768 chars)',
        },
      },
      required: ['taskId', 'message'],
      additionalProperties: false,
    },
  },
  {
    name: 'stop_subtask',
    description:
      'Gracefully stop a running child task\'s agent session. If a reason is provided, it is sent as a warning message ' +
      'before the hard stop (with a configurable grace period). The task status is updated to "failed" with the stop reason. ' +
      'Only the direct parent task can stop a child.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The child task ID to stop',
        },
        reason: {
          type: 'string',
          description: 'Optional reason for stopping — sent as a warning message to the child before the hard stop',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'retry_subtask',
    description:
      'Stop a failed or stalled child task and dispatch a replacement with optionally modified instructions. ' +
      'Only the direct parent can retry a subtask. The replacement inherits the same dispatch depth and project defaults. ' +
      'Rate-limited: max retries per task apply (configurable via ORCHESTRATOR_MAX_RETRIES_PER_TASK).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID of the child task to retry',
        },
        newDescription: {
          type: 'string',
          description: 'Optional replacement description. If omitted, the original description is reused with failure context appended.',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'add_dependency',
    description:
      'Add a dependency edge between two tasks in the execution graph. The first task (taskId) will depend on the second task (dependsOnTaskId). ' +
      'Caller must be the parent of both tasks. Cycle detection prevents circular dependencies. ' +
      'Idempotent: adding the same dependency twice is a no-op.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task that should depend on another task',
        },
        dependsOnTaskId: {
          type: 'string',
          description: 'The task that must complete first',
        },
      },
      required: ['taskId', 'dependsOnTaskId'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_pending_subtask',
    description:
      'Remove a not-yet-started (queued) child task from the execution graph. The task is marked as cancelled and all dependency edges are cleaned up. ' +
      'Only the direct parent can remove a subtask. Cannot remove running tasks — use retry_subtask for those.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        taskId: {
          type: 'string',
          description: 'The task ID of the queued child task to remove',
        },
      },
      required: ['taskId'],
      additionalProperties: false,
    },
  },
];
