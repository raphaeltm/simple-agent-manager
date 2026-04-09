/**
 * MCP tool definitions — workspace info, environment, CI, cost, and observability tools.
 */

export const WORKSPACE_TOOLS = [
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
];
