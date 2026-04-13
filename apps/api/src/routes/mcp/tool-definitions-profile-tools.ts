/**
 * MCP tool definitions — agent profile CRUD tools.
 *
 * Lets agents manage reusable agent profile configurations for their project.
 */

/** Shared property schemas for profile fields used by both create and update tools. */
const PROFILE_FIELD_PROPERTIES = {
  description: {
    type: 'string',
    description: 'Human-readable description of the profile\'s purpose',
  },
  agentType: {
    type: 'string',
    description: 'Agent type (e.g., claude-code, codex). Defaults to project default.',
  },
  model: {
    type: 'string',
    description: 'Model identifier (e.g., claude-sonnet-4-5-20250929, claude-opus-4-6)',
  },
  permissionMode: {
    type: 'string',
    description: 'Permission mode: default, acceptEdits, plan, dontAsk, bypassPermissions',
  },
  systemPromptAppend: {
    type: 'string',
    description: 'Text appended to the agent\'s system prompt',
  },
  maxTurns: {
    type: 'number',
    description: 'Maximum conversation turns',
  },
  timeoutMinutes: {
    type: 'number',
    description: 'Task timeout in minutes',
  },
  vmSizeOverride: {
    type: 'string',
    description: 'VM size override: small, medium, large',
  },
  provider: {
    type: 'string',
    description: 'Cloud provider: hetzner, scaleway, gcp',
  },
  vmLocation: {
    type: 'string',
    description: 'VM location/region for the provider',
  },
  workspaceProfile: {
    type: 'string',
    description: 'Workspace profile: full, lightweight',
  },
  devcontainerConfigName: {
    type: 'string',
    description: 'Devcontainer config name (subdirectory under .devcontainer/). Omit for auto-discover default.',
  },
  taskMode: {
    type: 'string',
    description: 'Task mode: task, conversation',
  },
} as const;

export const PROFILE_TOOLS = [
  {
    name: 'list_agent_profiles',
    description:
      'List all agent profiles available in your project, including built-in profiles. ' +
      'Returns a concise summary of each profile (id, name, description, agentType, model, isBuiltin). ' +
      'Use get_agent_profile to get full details of a specific profile.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_agent_profile',
    description:
      'Get full details of a specific agent profile by ID, including all configuration fields.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        profileId: {
          type: 'string',
          description: 'The agent profile ID to retrieve',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_agent_profile',
    description:
      'Create a new agent profile in the current project. Profiles define reusable agent configurations ' +
      'for task execution roles (e.g., planner, implementer, reviewer). ' +
      'Valid permissionMode values: default, acceptEdits, plan, dontAsk, bypassPermissions. ' +
      'Valid vmSize values: small, medium, large. ' +
      'Valid taskMode values: task, conversation. ' +
      'Valid workspaceProfile values: full, lightweight.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for the profile within the project',
        },
        ...PROFILE_FIELD_PROPERTIES,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_agent_profile',
    description:
      'Update an existing agent profile. Only provided fields are changed; omitted fields remain unchanged. ' +
      'Valid permissionMode values: default, acceptEdits, plan, dontAsk, bypassPermissions. ' +
      'Valid vmSize values: small, medium, large. ' +
      'Valid taskMode values: task, conversation. ' +
      'Valid workspaceProfile values: full, lightweight.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        profileId: {
          type: 'string',
          description: 'The agent profile ID to update',
        },
        name: {
          type: 'string',
          description: 'New name for the profile',
        },
        ...PROFILE_FIELD_PROPERTIES,
      },
      required: ['profileId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_agent_profile',
    description:
      'Delete an agent profile from the current project. Both built-in and custom profiles can be deleted.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        profileId: {
          type: 'string',
          description: 'The agent profile ID to delete',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
  },
];
