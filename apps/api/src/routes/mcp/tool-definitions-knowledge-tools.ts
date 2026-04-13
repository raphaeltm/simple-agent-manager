/**
 * MCP tool definitions for the Knowledge Graph.
 */

export const KNOWLEDGE_TOOLS = [
  {
    name: 'add_knowledge',
    description:
      'Add a new observation (fact) to the project knowledge graph. Creates the entity if it does not exist. ' +
      'Use this when you learn something about the user — preferences, coding style, workflow habits, project conventions. ' +
      'Examples: "Prefers TypeScript over JavaScript", "Wants terse responses", "Uses kebab-case for filenames".',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityName: { type: 'string', description: 'Name of the knowledge entity (e.g., "CodeStyle", "User", "Architecture")' },
        entityType: {
          type: 'string',
          description: 'Type of entity: preference, style, context, expertise, workflow, personality, custom',
          enum: ['preference', 'style', 'context', 'expertise', 'workflow', 'personality', 'custom'],
        },
        observation: { type: 'string', description: 'The fact or observation to store' },
        confidence: { type: 'number', description: 'Confidence level 0.0-1.0 (default: 0.7). Use 0.9+ for explicit user statements.' },
        sourceType: {
          type: 'string',
          description: 'How this was learned: explicit (user said it), inferred (agent deduced), behavioral (observed from actions)',
          enum: ['explicit', 'inferred', 'behavioral'],
        },
      },
      required: ['entityName', 'observation'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_knowledge',
    description:
      'Update an existing observation with new content. Creates a superseding observation and marks the old one as inactive (non-lossy update).',
    inputSchema: {
      type: 'object' as const,
      properties: {
        observationId: { type: 'string', description: 'ID of the observation to update' },
        newContent: { type: 'string', description: 'Updated observation text' },
        confidence: { type: 'number', description: 'Optional new confidence level 0.0-1.0' },
      },
      required: ['observationId', 'newContent'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_knowledge',
    description: 'Soft-delete an observation (marks as inactive). Use when an observation is no longer accurate.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        observationId: { type: 'string', description: 'ID of the observation to remove' },
      },
      required: ['observationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_knowledge',
    description: 'Get a specific knowledge entity with all its active observations and relations. Look up by name or ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityName: { type: 'string', description: 'Name of the entity to retrieve' },
        entityId: { type: 'string', description: 'ID of the entity to retrieve (alternative to entityName)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'search_knowledge',
    description: 'Full-text search across all observations in the project knowledge graph. Returns matching observations with their entities.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        query: { type: 'string', description: 'Search query text' },
        entityType: { type: 'string', description: 'Optional filter by entity type' },
        minConfidence: { type: 'number', description: 'Optional minimum confidence threshold (0.0-1.0)' },
        limit: { type: 'number', description: 'Max results to return (default: 20)' },
      },
      required: ['query'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_project_knowledge',
    description: 'Get all knowledge entities in the project with observation counts, ordered by most recently updated.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityType: { type: 'string', description: 'Optional filter by entity type' },
        limit: { type: 'number', description: 'Max entities to return (default: 50)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_relevant_knowledge',
    description:
      'Find the most relevant knowledge for a given context. Uses full-text search weighted by confidence and recency. ' +
      'Call this at the start of each session with the task description to get relevant user preferences and project context.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        context: { type: 'string', description: 'Context string (e.g., current task description, conversation topic)' },
        limit: { type: 'number', description: 'Max observations to return (default: 20)' },
      },
      required: ['context'],
      additionalProperties: false,
    },
  },
  {
    name: 'relate_knowledge',
    description: 'Create a relation between two knowledge entities. Both entities must already exist.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        sourceEntity: { type: 'string', description: 'Name of the source entity' },
        targetEntity: { type: 'string', description: 'Name of the target entity' },
        relationType: {
          type: 'string',
          description: 'Type of relation: influences, contradicts, supports, requires, related_to',
          enum: ['influences', 'contradicts', 'supports', 'requires', 'related_to'],
        },
        description: { type: 'string', description: 'Optional description of the relation' },
      },
      required: ['sourceEntity', 'targetEntity', 'relationType'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_related',
    description: 'Get entities related to a given entity, optionally filtered by relation type.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        entityName: { type: 'string', description: 'Name of the entity' },
        relationType: { type: 'string', description: 'Optional filter by relation type' },
      },
      required: ['entityName'],
      additionalProperties: false,
    },
  },
  {
    name: 'confirm_knowledge',
    description:
      'Confirm that an existing observation is still accurate. Bumps the last_confirmed_at timestamp. ' +
      'Use this when you observe that existing knowledge is still correct.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        observationId: { type: 'string', description: 'ID of the observation to confirm' },
      },
      required: ['observationId'],
      additionalProperties: false,
    },
  },
  {
    name: 'flag_contradiction',
    description:
      'Flag when new information contradicts existing knowledge. Creates the new observation and a "contradicts" relation for user resolution.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        existingObservationId: { type: 'string', description: 'ID of the existing observation being contradicted' },
        newObservation: { type: 'string', description: 'The new contradicting observation text' },
      },
      required: ['existingObservationId', 'newObservation'],
      additionalProperties: false,
    },
  },
];
