/**
 * MCP tool definitions for Project Policies (Phase 4: Policy Propagation).
 */

export const POLICY_TOOLS = [
  {
    name: 'add_policy',
    description:
      'Add a new project policy. Policies are dynamic rules, constraints, delegation settings, or preferences that apply to all agents working in this project. ' +
      'Use this when a human states a rule ("always use conventional commits"), a constraint ("this project uses Valibot, not Zod"), ' +
      'a delegation preference ("agents may auto-delegate research"), or any preference that should persist across sessions.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Policy category: rule (must follow), constraint (technical limitation), delegation (agent autonomy), preference (soft guidance)',
          enum: ['rule', 'constraint', 'delegation', 'preference'],
        },
        title: { type: 'string', description: 'Short title summarizing the policy (max 200 chars)' },
        content: { type: 'string', description: 'Full policy content with details and rationale (max 2000 chars)' },
        source: {
          type: 'string',
          description: 'How this policy was created: explicit (human stated it) or inferred (agent deduced from behavior)',
          enum: ['explicit', 'inferred'],
        },
        confidence: { type: 'number', description: 'Confidence level 0.0-1.0 (default: 0.8). Use 0.9+ for explicit human statements.' },
      },
      required: ['category', 'title', 'content'],
      additionalProperties: false,
    },
  },
  {
    name: 'list_policies',
    description: 'List active project policies. Optionally filter by category.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Optional filter by category: rule, constraint, delegation, preference',
          enum: ['rule', 'constraint', 'delegation', 'preference'],
        },
        includeInactive: { type: 'boolean', description: 'Include deactivated policies (default: false)' },
        limit: { type: 'number', description: 'Max results to return (default: 50)' },
        offset: { type: 'number', description: 'Pagination offset (default: 0)' },
      },
      additionalProperties: false,
    },
  },
  {
    name: 'get_policy',
    description: 'Get a specific project policy by ID.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string', description: 'ID of the policy to retrieve' },
      },
      required: ['policyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'update_policy',
    description: 'Update an existing project policy. Can change title, content, category, confidence, or active status.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string', description: 'ID of the policy to update' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'New content' },
        category: {
          type: 'string',
          description: 'New category',
          enum: ['rule', 'constraint', 'delegation', 'preference'],
        },
        active: { type: 'boolean', description: 'Set active/inactive' },
        confidence: { type: 'number', description: 'New confidence level 0.0-1.0' },
      },
      required: ['policyId'],
      additionalProperties: false,
    },
  },
  {
    name: 'remove_policy',
    description: 'Deactivate a project policy (soft-delete). The policy remains in history but no longer applies to agents.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string', description: 'ID of the policy to deactivate' },
      },
      required: ['policyId'],
      additionalProperties: false,
    },
  },
];
