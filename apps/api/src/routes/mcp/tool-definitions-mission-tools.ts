/**
 * MCP tool definitions — mission orchestration (state entries & handoff packets).
 */

export const MISSION_TOOLS = [
  {
    name: 'create_mission',
    description:
      'Create a new mission to group related tasks with shared state and structured handoffs. ' +
      'Returns the mission ID. The mission starts in "planning" status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        title: {
          type: 'string',
          description: 'Short mission title (max 200 chars)',
        },
        description: {
          type: 'string',
          description: 'Detailed mission description (max 5000 chars)',
        },
        budgetConfig: {
          type: 'object',
          description: 'Optional budget constraints for the mission',
          properties: {
            maxTasks: { type: 'number', description: 'Maximum tasks allowed' },
            maxConcurrentTasks: { type: 'number', description: 'Maximum concurrent tasks' },
          },
        },
      },
      required: ['title'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_mission',
    description:
      'Get details for a mission including its current status and task summary.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission ID to look up',
        },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_mission_state',
    description:
      'Publish a structured state entry (decision, assumption, fact, contract, artifact_ref, risk, todo) ' +
      'to the mission\'s shared state. Visible to all tasks within the mission.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission this state entry belongs to',
        },
        entryType: {
          type: 'string',
          enum: ['decision', 'assumption', 'fact', 'contract', 'artifact_ref', 'risk', 'todo'],
          description: 'Type of state entry',
        },
        title: {
          type: 'string',
          description: 'Short title for the state entry (max 200 chars)',
        },
        content: {
          type: 'string',
          description: 'Detailed content (max 2000 chars)',
        },
      },
      required: ['missionId', 'entryType', 'title'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_mission_state',
    description:
      'Retrieve all state entries for a mission, optionally filtered by entry type. ' +
      'Returns decisions, assumptions, facts, contracts, artifact refs, risks, and todos.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission to retrieve state for',
        },
        entryType: {
          type: 'string',
          enum: ['decision', 'assumption', 'fact', 'contract', 'artifact_ref', 'risk', 'todo'],
          description: 'Optional filter by entry type',
        },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
  {
    name: 'publish_handoff',
    description:
      'Publish a structured handoff packet from the current task to another task in the same mission. ' +
      'Handoffs contain a summary, facts learned, open questions, artifact references, and suggested next actions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission this handoff belongs to',
        },
        toTaskId: {
          type: 'string',
          description: 'Optional target task ID (null for broadcast to mission)',
        },
        summary: {
          type: 'string',
          description: 'Executive summary of what was accomplished and what remains (max 5000 chars)',
        },
        facts: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              key: { type: 'string', description: 'Fact identifier' },
              value: { type: 'string', description: 'Fact value' },
              confidence: { type: 'number', description: 'Confidence 0-1' },
            },
            required: ['key', 'value'],
          },
          description: 'Facts learned during this task (max 50)',
        },
        openQuestions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Unresolved questions for the next task (max 20)',
        },
        artifactRefs: {
          type: 'array',
          items: {
            type: 'object',
            properties: {
              type: { type: 'string', description: 'Artifact type (file, branch, pr, url)' },
              path: { type: 'string', description: 'Path or URL to the artifact' },
              description: { type: 'string', description: 'What this artifact is' },
            },
            required: ['type', 'path'],
          },
          description: 'References to artifacts created or modified (max 30)',
        },
        suggestedActions: {
          type: 'array',
          items: { type: 'string' },
          description: 'Recommended next actions (max 20)',
        },
      },
      required: ['missionId', 'summary'],
      additionalProperties: false,
    },
  },
  {
    name: 'get_handoff',
    description:
      'Retrieve handoff packets for a mission. Returns all structured handoff envelopes.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        missionId: {
          type: 'string',
          description: 'The mission to retrieve handoffs for',
        },
      },
      required: ['missionId'],
      additionalProperties: false,
    },
  },
];
