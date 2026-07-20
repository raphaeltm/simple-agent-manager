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
      'Mark the current task as completed. Call this after all work is done and changes are pushed. ' +
      'Optionally include structured evidence describing tests, staging checks, CI, manual verification, PR URL, or notes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        summary: {
          type: 'string',
          description: 'Brief summary of what was accomplished',
        },
        evidence: {
          type: 'object',
          description:
            'Optional structured completion evidence. Malformed evidence rejects the whole completion request.',
          properties: {
            testsRun: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  command: { type: 'string' },
                  passed: { type: 'boolean' },
                  detail: { type: 'string' },
                },
                required: ['command', 'passed'],
                additionalProperties: false,
              },
            },
            verifications: {
              type: 'array',
              items: {
                type: 'object',
                properties: {
                  kind: {
                    type: 'string',
                    enum: ['test', 'staging', 'manual', 'ci', 'other'],
                  },
                  description: { type: 'string' },
                  evidence: { type: 'string' },
                },
                required: ['kind', 'description'],
                additionalProperties: false,
              },
            },
            prUrl: { type: 'string' },
            notes: { type: 'string' },
          },
          additionalProperties: false,
        },
      },
      additionalProperties: false,
    },
  },
  // ─── Task dispatch (agent-to-agent) ────────────────────────────────────
  {
    name: 'dispatch_task',
    description:
      'Dispatch a new task to another agent in the current project. Use this to spawn parallel work, delegate sub-tasks, or follow up on findings. Runtime follows the selected skill/profile unless explicitly overridden; cf-container starts an Instant session without VM sizing. Rate-limited: max dispatch depth, per-task limit, and per-project active limit apply.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        description: {
          type: 'string',
          description:
            'Task description — synthesize context from your conversation into a clear, actionable brief. Do NOT dump raw conversation history.',
        },
        vmSize: {
          type: 'string',
          description:
            'VM size for the dispatched task (small, medium, large). Defaults to project default.',
          enum: ['small', 'medium', 'large'],
        },
        runtime: {
          type: 'string',
          enum: ['vm', 'cf-container'],
          description:
            'Execution runtime override. "cf-container" launches an instant Cloudflare container (fast start, no cloud credential needed, no VM sizing). Defaults to skill/profile runtime, else VM.',
        },
        priority: {
          type: 'number',
          description: 'Task priority (0 = default). Higher values = higher priority.',
        },
        references: {
          type: 'array',
          items: { type: 'string' },
          description:
            'File paths, spec references, or URLs to include as context for the dispatched agent.',
        },
        branch: {
          type: 'string',
          description:
            "Git branch for the new workspace to check out. Defaults to the project's default branch (usually main). Only set this if you have already pushed the branch to the remote.",
        },
        agentProfileId: {
          type: 'string',
          description:
            'Agent profile ID or name to use. Profile settings (model, permissionMode, agentType, vmSize, etc.) override project defaults but are overridden by explicit task-level fields.',
        },
        skillId: {
          type: 'string',
          description:
            'Skill ID or name to use as the repeatable-work configuration layer. Skill settings override profile settings.',
        },
        taskMode: {
          type: 'string',
          description:
            'Task execution mode. "task" is recommended for subtasks and reports completion. "conversation" requires active lifecycle management via send_message_to_subtask.',
          enum: ['task', 'conversation'],
        },
        agentType: {
          type: 'string',
          description:
            'Agent type to use (e.g., "claude-code", "openai-codex"). Defaults to profile or project default.',
        },
        workspaceProfile: {
          type: 'string',
          description:
            'Workspace provisioning profile. "full" includes full devcontainer build. "lightweight" skips it for faster startup.',
          enum: ['full', 'lightweight'],
        },
        devcontainerConfigName: {
          type: ['string', 'null'],
          description:
            'Devcontainer config name — a subdirectory under .devcontainer/ (e.g., "data-science"). Null or omitted means auto-discover default config. Only relevant when workspaceProfile is "full".',
        },
        provider: {
          type: 'string',
          description:
            'Cloud provider for auto-provisioned nodes (e.g., "hetzner", "scaleway", "gcp"). Defaults to profile or project default.',
        },
        vmLocation: {
          type: 'string',
          description:
            'VM location/datacenter. Must be valid for the selected provider. Defaults to profile or project default.',
        },
        missionId: {
          type: 'string',
          description:
            'Mission ID to attach this task to. The task inherits the mission context and can read/write mission state.',
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
          description:
            'Explain what you need from the human — be specific about the decision, question, or blocker.',
        },
        category: {
          type: 'string',
          description: 'Category of input needed.',
          enum: ['decision', 'clarification', 'approval', 'error_help'],
        },
        options: {
          type: 'array',
          items: { type: 'string' },
          description:
            'Optional list of choices for the human to pick from (e.g., ["Option A", "Option B"]).',
        },
      },
      required: ['context'],
      additionalProperties: false,
    },
  },
];
