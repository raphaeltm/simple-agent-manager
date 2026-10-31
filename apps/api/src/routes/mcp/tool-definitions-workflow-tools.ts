import { nullableMcpProperty } from './tool-definitions-shared-fields';

export const WORKFLOW_TOOLS = [
  {
    name: 'start_workflow_run',
    description:
      'Start a durable single-owner workflow. SAM starts each VM agent step after its prerequisites complete, passing their summaries and artifact references. No coordinator needs to remain awake. Reuse the same requestKey and plan after a lost response; a changed plan requires a new key. Agent steps require a VM profile. Wait steps listen for matching project events without a VM, with a finite timeout.',
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
                // Two step shapes, described rather than expressed as `oneOf`, which Gemini
                // function calling rejects. services/workflow-plan.ts enforces them.
                description:
                  'Either an agent step (key, title, instructions, agentProfileId; kind omitted or "agent") or a wait step (key, title, kind "wait", wait).',
                required: ['key', 'title'],
                properties: {
                  kind: { type: 'string', enum: ['agent', 'wait'] },
                  key: { type: 'string', description: 'Unique step key.' },
                  title: { type: 'string' },
                  instructions: { type: 'string' },
                  agentProfileId: { type: 'string' },
                  after: { type: 'array', items: { type: 'string' } },
                  wait: {
                    type: 'object',
                    additionalProperties: false,
                    required: ['description', 'source', 'eventTypes', 'timeoutMs'],
                    properties: {
                      description: {
                        type: 'string',
                        description: 'Plain-language condition shown to users.',
                      },
                      source: {
                        type: 'string',
                        description:
                          'Exact ProjectData event source. Agent message channels are excluded.',
                      },
                      eventTypes: { type: 'array', minItems: 1, items: { type: 'string' } },
                      subject: nullableMcpProperty({
                        type: 'object',
                        properties: { type: { type: 'string' }, id: { type: 'string' } },
                        required: ['type', 'id'],
                      }),
                      timeoutMs: {
                        type: 'integer',
                        minimum: 1,
                        description: 'Finite wait duration, bounded by workflow lifetime.',
                      },
                    },
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
