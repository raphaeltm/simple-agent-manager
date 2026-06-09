/**
 * MCP tool definitions — skill CRUD tools.
 *
 * Lets agents manage reusable, project-scoped skills. Skills are a profile-override
 * layer: skill fields override the resolved agent profile when a task runs the skill.
 */

/** Shared property schemas for skill fields used by both create and update tools. */
const SKILL_FIELD_PROPERTIES = {
  description: {
    type: 'string',
    description: 'Human-readable description of the skill\'s purpose',
  },
  agentType: {
    type: 'string',
    description: 'Agent type (e.g., claude-code, codex). Defaults to project default.',
  },
  model: {
    type: 'string',
    description: 'Model identifier override. Omit to use the resolved profile or platform default.',
  },
  permissionMode: {
    type: 'string',
    description: 'Permission mode: default, acceptEdits, plan, dontAsk, bypassPermissions',
  },
  systemPromptAppend: {
    type: 'string',
    description: 'Text appended to the agent\'s system prompt (combined with the resolved profile\'s append)',
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
    description: 'Default task mode for this skill. Most skills should use "task" or leave this unset; "conversation" requires active lifecycle management.',
  },
  resourceRequirementsJson: {
    type: 'string',
    description: 'JSON object string describing resource requirements for this skill. Must parse to a JSON object.',
  },
  defaultProfileId: {
    type: 'string',
    description: 'Agent profile ID this skill resolves against by default. Must reference an accessible agent profile.',
  },
} as const;

/** Shared valid-values hint appended to create and update tool descriptions. */
const VALID_VALUES_HINT =
  'Valid permissionMode values: default, acceptEdits, plan, dontAsk, bypassPermissions. ' +
  'Valid vmSize values: small, medium, large. ' +
  'Valid taskMode values: task, conversation. ' +
  'Valid workspaceProfile values: full, lightweight.';

export const SKILL_TOOLS = [
  {
    name: 'list_skills',
    description:
      'List all skills available in your project. ' +
      'Returns a concise summary of each skill (id, name, description, agentType, model, isBuiltin). ' +
      'Use get_skill to get full details of a specific skill.',
    inputSchema: {
      type: 'object' as const,
      properties: {},
      additionalProperties: false,
    },
  },
  {
    name: 'get_skill',
    description:
      'Get full details of a specific skill by ID, including all configuration fields and the default profile binding.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: {
          type: 'string',
          description: 'The skill ID to retrieve',
        },
      },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
  {
    name: 'create_skill',
    description:
      'Create a new skill in the current project. Skills define reusable, repeatable-work configurations ' +
      'that override the resolved agent profile when a task runs the skill. ' +
      VALID_VALUES_HINT,
    inputSchema: {
      type: 'object' as const,
      properties: {
        name: {
          type: 'string',
          description: 'Unique name for the skill within the project',
        },
        ...SKILL_FIELD_PROPERTIES,
      },
      required: ['name'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_skill',
    description:
      'Update an existing skill. Only provided fields are changed; omitted fields remain unchanged. ' +
      VALID_VALUES_HINT,
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: {
          type: 'string',
          description: 'The skill ID to update',
        },
        name: {
          type: 'string',
          description: 'New name for the skill',
        },
        ...SKILL_FIELD_PROPERTIES,
      },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
  {
    name: 'delete_skill',
    description: 'Delete a skill from the current project.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        skillId: {
          type: 'string',
          description: 'The skill ID to delete',
        },
      },
      required: ['skillId'],
      additionalProperties: false,
    },
  },
];
