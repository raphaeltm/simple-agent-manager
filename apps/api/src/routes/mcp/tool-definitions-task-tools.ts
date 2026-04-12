/**
 * MCP tool definitions — task lifecycle, dispatch, and notification tools.
 */

export const TASK_LIFECYCLE_TOOLS = [
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
        agentProfileId: {
          type: 'string',
          description: 'Agent profile ID or name to use. Profile settings (model, permissionMode, agentType, vmSize, etc.) override project defaults but are overridden by explicit task-level fields.',
        },
        taskMode: {
          type: 'string',
          description: 'Task execution mode. "task" (default): agent pushes, creates PR, calls complete_task. "conversation": agent responds conversationally, human controls lifecycle.',
          enum: ['task', 'conversation'],
        },
        agentType: {
          type: 'string',
          description: 'Agent type to use (e.g., "claude-code", "openai-codex"). Defaults to profile or project default.',
        },
        workspaceProfile: {
          type: 'string',
          description: 'Workspace provisioning profile. "full" includes full devcontainer build. "lightweight" skips it for faster startup.',
          enum: ['full', 'lightweight'],
        },
        devcontainerConfigName: {
          type: ['string', 'null'],
          description: 'Devcontainer config name — a subdirectory under .devcontainer/ (e.g., "data-science"). Null or omitted means auto-discover default config. Only relevant when workspaceProfile is "full".',
        },
        provider: {
          type: 'string',
          description: 'Cloud provider for auto-provisioned nodes (e.g., "hetzner", "scaleway", "gcp"). Defaults to profile or project default.',
        },
        vmLocation: {
          type: 'string',
          description: 'VM location/datacenter. Must be valid for the selected provider. Defaults to profile or project default.',
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
];
