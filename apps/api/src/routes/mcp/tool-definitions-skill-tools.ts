/**
 * MCP tool definitions — skill CRUD tools.
 *
 * Lets agents manage reusable, project-scoped skills. Skills are a profile-override
 * layer: skill fields override the resolved agent profile when a task runs the skill.
 */
import { SHARED_CONFIG_FIELD_PROPERTIES, VALID_VALUES_HINT } from './tool-definitions-shared-fields';

/** Skill field properties = shared config fields + skill-specific extras. */
const SKILL_FIELD_PROPERTIES = {
  ...SHARED_CONFIG_FIELD_PROPERTIES,
  resourceRequirementsJson: {
    type: 'string',
    description: 'JSON object string describing resource requirements for this skill. Must parse to a JSON object.',
  },
  defaultProfileId: {
    type: 'string',
    description: 'Agent profile ID this skill resolves against by default. Must reference an accessible agent profile.',
  },
} as const;

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
