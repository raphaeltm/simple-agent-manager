/**
 * Shared MCP tool definition field schemas for profiles and skills.
 *
 * Both profiles and skills expose overlapping configuration fields.
 * This module defines the shared JSON Schema properties and valid-values
 * hint so they are written once and imported by both tool-definition files.
 */

/** Shared property schemas for configuration fields common to profiles and skills. */
export const SHARED_CONFIG_FIELD_PROPERTIES = {
  description: {
    type: 'string',
    description: 'Human-readable description of the configuration\'s purpose',
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
    description: 'Reasoning effort: auto, low, medium, high, xhigh, max. Unsupported values are rejected for the selected agent type.',
  },
  permissionMode: {
    type: 'string',
    description: 'Permission mode: default, acceptEdits, plan, dontAsk, bypassPermissions',
  },
  systemPromptAppend: {
    type: 'string',
    description: 'Text appended to the agent\'s system prompt',
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
    description: 'VM size override: small, medium, large',
  },
  provider: {
    type: 'string',
    description: 'Cloud provider: hetzner, scaleway, gcp, vultr, digitalocean',
  },
  vmLocation: {
    type: 'string',
    description: 'VM location/region for the provider',
  },
  workspaceProfile: {
    type: 'string',
    description: 'Workspace profile: full, lightweight',
  },
  devcontainerConfigName: {
    type: 'string',
    description: 'Devcontainer config name (subdirectory under .devcontainer/). Omit for auto-discover default.',
  },
  taskMode: {
    type: 'string',
    description: 'Default task mode. Most configs should use "task" or leave this unset; "conversation" requires active lifecycle management.',
  },
} as const;

/** Shared valid-values hint appended to create and update tool descriptions. */
export const VALID_VALUES_HINT =
  'Valid permissionMode values: default, acceptEdits, plan, dontAsk, bypassPermissions. ' +
  'Valid effort values: auto, low, medium, high, xhigh, max. ' +
  'Valid vmSize values: small, medium, large. ' +
  'Valid taskMode values: task, conversation. ' +
  'Valid workspaceProfile values: full, lightweight.';
