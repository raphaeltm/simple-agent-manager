/**
 * MCP tool definitions — agent profile CRUD tools.
 *
 * Lets agents manage reusable agent profile configurations for their project.
 */
import { SHARED_CONFIG_FIELD_PROPERTIES, VALID_VALUES_HINT } from './tool-definitions-shared-fields';

const PROFILE_FIELD_PROPERTIES = SHARED_CONFIG_FIELD_PROPERTIES;

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
      VALID_VALUES_HINT,
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
      VALID_VALUES_HINT,
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
  {
    name: 'add_profile_env_var',
    description:
      'Set or update a runtime environment variable scoped to an agent profile. ' +
      'When a task uses this profile, profile env vars override project env vars with the same key.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        profileId: {
          type: 'string',
          description: 'The project-scoped agent profile ID',
        },
        key: {
          type: 'string',
          description: 'Environment variable key, matching [A-Za-z_][A-Za-z0-9_]*',
        },
        value: {
          type: 'string',
          description: 'Environment variable value',
        },
        isSecret: {
          type: 'boolean',
          description: 'Encrypt the value at rest and mask it in list responses',
        },
      },
      required: ['profileId', 'key', 'value'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_profile_env_var',
    description: 'Remove a runtime environment variable from an agent profile.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        profileId: {
          type: 'string',
          description: 'The project-scoped agent profile ID',
        },
        key: {
          type: 'string',
          description: 'Environment variable key to remove',
        },
      },
      required: ['profileId', 'key'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_profile_env_vars',
    description:
      'List runtime environment variables scoped to an agent profile. Secret values are masked.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        profileId: {
          type: 'string',
          description: 'The project-scoped agent profile ID',
        },
      },
      required: ['profileId'],
      additionalProperties: false,
    },
  },
];
