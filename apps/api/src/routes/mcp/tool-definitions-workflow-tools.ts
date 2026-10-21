export const WORKFLOW_TOOLS = [
  {
    name: 'start_workflow_run',
    description:
      'Start a durable single-owner workflow. SAM starts each VM agent step after its prerequisites complete, passing their summaries and artifact references. No coordinator needs to remain awake. Reuse the same requestKey and plan after a lost response; a changed plan requires a new key. Profiles are required. No templates, human gates or external-event waits yet.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['requestKey', 'plan'],
      properties: {
        requestKey: {
          type: 'string',
          description: 'Stable unique key for this intended run. Reuse on retry.',
        },
        plan: {
          type: 'object',
          additionalProperties: false,
          required: ['title', 'goal', 'steps'],
          properties: {
            title: { type: 'string' },
            goal: { type: 'string' },
            steps: {
              type: 'array',
              minItems: 1,
              maxItems: 25,
              items: {
                type: 'object',
                additionalProperties: false,
                required: ['key', 'title', 'instructions', 'agentProfileId'],
                properties: {
                  key: {
                    type: 'string',
                    description: 'Unique step key, letters/digits/underscore/hyphen.',
                  },
                  title: { type: 'string' },
                  instructions: { type: 'string' },
                  agentProfileId: { type: 'string' },
                  after: {
                    type: 'array',
                    items: { type: 'string' },
                    description: 'Prerequisite step keys; all must succeed.',
                  },
                },
              },
            },
          },
        },
      },
    },
  },
  {
    name: 'get_workflow_run',
    description:
      'Read your workflow run, step/attempt identities, task/session IDs, results, waiting/failure reasons and lifecycle activity.',
    inputSchema: {
      type: 'object' as const,
      additionalProperties: false,
      required: ['runId'],
      properties: { runId: { type: 'string' } },
    },
  },
];
