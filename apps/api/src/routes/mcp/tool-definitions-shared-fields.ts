/**
 * Shared MCP tool definition field schemas for profiles and skills.
 *
 * Both profiles and skills expose overlapping configuration fields.
 * This module defines the shared JSON Schema properties and valid-values
 * hint so they are written once and imported by both tool-definition files.
 */
import {
  AGENT_PROFILE_RUNTIMES,
  DEFAULT_AGENT_PERMISSION_MODE,
} from '@simple-agent-manager/shared';

export const RESOURCE_REQUIREMENTS_FIELD_PROPERTIES = {
  minVcpu: { type: 'number', exclusiveMinimum: 0 },
  minMemoryGb: { type: 'number', exclusiveMinimum: 0 },
  minDiskGb: { type: 'number', minimum: 0 },
  exclusiveNode: { type: 'boolean' },
} as const;

/**
 * Wraps a property schema so it also accepts `null`, in a shape Gemini function calling accepts.
 *
 * Vertex rejects a schema node that sets any field alongside `anyOf`. A JSON Schema type array
 * (`type: ['string', 'null']`) is not safe either: OpenCode's Gemini sanitizer rewrites it into
 * `anyOf` and keeps the node's `enum` and `description`, which Vertex then rejects. That is how
 * `create_agent_profile.runtime` failed every OpenCode prompt on a Gemini model. So `anyOf` is the
 * node's only field, and the description lives on the non-null branch.
 * `tests/unit/routes/mcp-tool-schema-gemini-compat.test.ts` enforces this for every tool.
 */
export function nullableMcpProperty<const T extends Record<string, unknown>>(schema: T) {
  return { anyOf: [schema, { type: 'null' }] } as const;
}

export function resourceRequirementsMcpProperty(options: {
  nullable: boolean;
  description: string;
}) {
  const schema = {
    type: 'object',
    description: options.description,
    properties: RESOURCE_REQUIREMENTS_FIELD_PROPERTIES,
    additionalProperties: true,
  } as const;
  return options.nullable ? nullableMcpProperty(schema) : schema;
}

/** Shared property schemas for configuration fields common to profiles and skills. */
export const SHARED_CONFIG_FIELD_PROPERTIES = {
  description: {
    type: 'string',
    description: "Human-readable description of the configuration's purpose",
  },
  agentType: {
    type: 'string',
    description: 'Agent type (e.g., claude-code, codex). Defaults to project default.',
  },
  model: {
    type: 'string',
    description: 'Model identifier override. Omit to use the resolved default.',
  },
  effort: {
    type: 'string',
    description:
      'Reasoning effort: auto, low, medium, high, xhigh, max. Unsupported values are rejected for the selected agent type.',
  },
  permissionMode: {
    type: 'string',
    description: `Permission mode: default, acceptEdits, plan, dontAsk, bypassPermissions. Omit to inherit project and user agent settings, which fall back to ${DEFAULT_AGENT_PERMISSION_MODE}.`,
  },
  systemPromptAppend: {
    type: 'string',
    description: "Text appended to the agent's system prompt",
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
    description:
      'Deprecated legacy VM size override: small, medium, large. Prefer resourceRequirements; the canonical compatibility adapter translates legacy tiers.',
  },
  resourceRequirements: resourceRequirementsMcpProperty({
    nullable: true,
    description:
      'Modern workload requirements for this configuration layer. Known fields: minVcpu, minMemoryGb, minDiskGb, and exclusiveNode. Placement uses explicit CPU, memory, and disk reservations. Omitted fields inherit; explicit false is preserved. Null clears the value on update.',
  }),
  resourceRequirementsJson: nullableMcpProperty({
    type: 'string',
    description:
      'Compatibility JSON string for workload requirements. Prefer resourceRequirements; only supported modern fields are persisted.',
  }),
  provider: {
    type: 'string',
    description: 'Cloud provider: hetzner, scaleway, gcp, vultr, infomaniak, digitalocean, upcloud',
  },
  vmLocation: {
    type: 'string',
    description: 'VM location/region for the provider',
  },
  workspaceProfile: {
    type: 'string',
    description: 'Workspace profile: full, lightweight',
  },
  runtime: nullableMcpProperty({
    type: 'string',
    enum: [...AGENT_PROFILE_RUNTIMES],
    description: 'Execution runtime: vm or cf-container. Use null to inherit the default.',
  }),
  devcontainerConfigName: {
    type: 'string',
    description:
      'Devcontainer config name (subdirectory under .devcontainer/). Omit for auto-discover default.',
  },
  taskMode: {
    type: 'string',
    description:
      'Default task mode. Most configs should use "task" or leave this unset; "conversation" requires active lifecycle management.',
  },
} as const;

/** Shared valid-values hint appended to create and update tool descriptions. */
export const VALID_VALUES_HINT =
  'Valid permissionMode values: default, acceptEdits, plan, dontAsk, bypassPermissions. ' +
  'Valid effort values: auto, low, medium, high, xhigh, max. ' +
  'Deprecated vmSize/vmSizeOverride values remain accepted: small, medium, large. Prefer resourceRequirements for workload sizing. ' +
  'Valid runtime values: vm, cf-container. ' +
  'Valid taskMode values: task, conversation. ' +
  'Valid workspaceProfile values: full, lightweight.';
