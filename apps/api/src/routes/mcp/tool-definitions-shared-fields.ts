/**
 * Shared MCP tool definition field schemas for profiles and skills.
 *
 * Both profiles and skills expose overlapping configuration fields.
 * This module defines the shared JSON Schema properties and valid-values
 * hint so they are written once and imported by both tool-definition files.
 */
import { AGENT_PROFILE_RUNTIMES } from '@simple-agent-manager/shared';

export const RESOURCE_REQUIREMENTS_FIELD_PROPERTIES = {
  minVcpu: { type: 'number', exclusiveMinimum: 0 },
  minMemoryGb: { type: 'number', exclusiveMinimum: 0 },
  minDiskGb: { type: 'number', minimum: 0 },
  exclusiveNode: { type: 'boolean' },
  maxCoTenants: { type: 'integer', minimum: 1, maximum: Number.MAX_SAFE_INTEGER },
} as const;

export function resourceRequirementsMcpProperty(
  options: { nullable: boolean; description: string }
) {
  return {
    type: options.nullable ? (['object', 'null'] as const) : ('object' as const),
    description: options.description,
    properties: RESOURCE_REQUIREMENTS_FIELD_PROPERTIES,
    additionalProperties: true,
  } as const;
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
    description: 'Permission mode: default, acceptEdits, plan, dontAsk, bypassPermissions',
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
  resourceRequirements: {
    ...resourceRequirementsMcpProperty({
      nullable: true,
      description:
        'Modern workload requirements for this configuration layer. Known fields: minVcpu, minMemoryGb, minDiskGb, exclusiveNode, maxCoTenants. CPU and memory must be positive; disk may be zero; maxCoTenants must be a positive safe integer. Omitted fields inherit; explicit false is preserved. Null clears the value on update.',
    }),
  },
  resourceRequirementsJson: {
    type: ['string', 'null'],
    description:
      'Compatibility JSON string for workload requirements. Prefer resourceRequirements; only supported modern fields are persisted.',
  },
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
  runtime: {
    type: ['string', 'null'],
    enum: [...AGENT_PROFILE_RUNTIMES, null],
    description: 'Execution runtime: vm or cf-container. Use null to inherit the default.',
  },
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
