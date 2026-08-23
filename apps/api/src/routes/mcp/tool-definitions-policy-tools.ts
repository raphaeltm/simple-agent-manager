/**
 * MCP tool definitions for Project Policies (Phase 4: Policy Propagation).
 */
import { POLICY_CATEGORIES, POLICY_SCOPES, POLICY_SOURCES } from '@simple-agent-manager/shared';

const SCOPE_DESCRIPTION =
  "How long this policy applies. 'always' (default) is a standing project policy injected into every future session. " +
  "'task' is a one-shot policy captured for a specific piece of work (\"use profile X for the 2026-08-21 reliability wave\") " +
  'and REQUIRES expiresAt, so it cannot outlive the work it was captured for.';

const EXPIRES_AT_DESCRIPTION =
  'Epoch milliseconds after which this policy stops being injected into sessions. Omit or null for a policy that never expires. ' +
  'Must be in the future. Required when scope is "task". The policy stays readable via get_policy and visible in list_policies after it expires.';

export const POLICY_TOOLS = [
  {
    name: 'add_policy',
    description:
      'Add a new project policy. Policies are dynamic rules, constraints, delegation settings, or preferences that apply to all agents working in this project. ' +
      'Use this when a human states a rule ("always use conventional commits"), a constraint ("this project uses Valibot, not Zod"), ' +
      'a delegation preference ("agents may auto-delegate research"), or any preference that should persist across sessions. ' +
      'IMPORTANT: if the statement is tied to a specific workflow, wave, or dated piece of work rather than being a standing rule, ' +
      'set scope to "task" and give it an expiresAt — otherwise it will be injected into every future session long after that work is done.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        category: {
          type: 'string',
          description: 'Policy category: rule (must follow), constraint (technical limitation), delegation (agent autonomy), preference (soft guidance)',
          enum: [...POLICY_CATEGORIES],
        },
        title: { type: 'string', description: 'Short title summarizing the policy (max 200 chars)' },
        content: { type: 'string', description: 'Full policy content with details and rationale (max 2000 chars)' },
        source: {
          type: 'string',
          description: 'How this policy was created: explicit (human stated it) or inferred (agent deduced from behavior)',
          enum: [...POLICY_SOURCES],
        },
        confidence: { type: 'number', description: 'Confidence level 0.0-1.0 (default: 0.8). Use 0.9+ for explicit human statements.' },
        scope: { type: 'string', description: SCOPE_DESCRIPTION, enum: [...POLICY_SCOPES] },
        expiresAt: { type: 'number', description: EXPIRES_AT_DESCRIPTION },
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
          enum: [...POLICY_CATEGORIES],
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
    description:
      'Update an existing project policy. Can change title, content, category, confidence, scope, expiry, or active status. ' +
      'Use this to give an existing one-shot policy an expiry once you notice it is tied to work that has finished.',
    inputSchema: {
      type: 'object' as const,
      properties: {
        policyId: { type: 'string', description: 'ID of the policy to update' },
        title: { type: 'string', description: 'New title' },
        content: { type: 'string', description: 'New content' },
        category: {
          type: 'string',
          description: 'New category',
          enum: [...POLICY_CATEGORIES],
        },
        active: { type: 'boolean', description: 'Set active/inactive' },
        confidence: { type: 'number', description: 'New confidence level 0.0-1.0' },
        scope: { type: 'string', description: SCOPE_DESCRIPTION, enum: [...POLICY_SCOPES] },
        expiresAt: {
          type: ['number', 'null'],
          description: `${EXPIRES_AT_DESCRIPTION} Pass null to clear an existing expiry and make the policy permanent.`,
        },
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
