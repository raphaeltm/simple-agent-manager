import {
  type AgentEffort,
  type AgentProfileRuntime,
  DEFAULT_AGENT_EFFORT,
  isAgentEffort,
  isAgentProfileRuntime,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';

/**
 * Field mappers shared by agent profiles and skills. Both entities store the
 * same base column set (a skill is a profile-override layer with a few extra
 * columns), so the row→response mapping, insert defaults, and partial-update
 * logic are identical for those base fields. Centralizing them here keeps the
 * two services in sync and avoids copy-pasted field lists.
 */

/** Base columns that copy verbatim from a DB row into the API response shape. */
export interface BaseProfileRow {
  id: string;
  projectId: string | null;
  userId: string;
  name: string;
  description: string | null;
  agentType: string;
  model: string | null;
  effort: unknown;
  permissionMode: string | null;
  systemPromptAppend: string | null;
  maxTurns: number | null;
  timeoutMinutes: number | null;
  vmSizeOverride: string | null;
  provider: string | null;
  vmLocation: string | null;
  workspaceProfile: string | null;
  runtime: unknown;
  devcontainerConfigName: string | null;
  taskMode: string | null;
  createdAt: string;
  updatedAt: string;
  isBuiltin: number;
}

export interface BaseProfileFieldsResponse {
  id: string;
  projectId: string | null;
  userId: string;
  name: string;
  description: string | null;
  agentType: string;
  model: string | null;
  effort: AgentEffort;
  permissionMode: string | null;
  systemPromptAppend: string | null;
  maxTurns: number | null;
  timeoutMinutes: number | null;
  vmSizeOverride: string | null;
  provider: string | null;
  vmLocation: string | null;
  workspaceProfile: string | null;
  runtime: AgentProfileRuntime | null;
  devcontainerConfigName: string | null;
  taskMode: string | null;
  createdAt: string;
  updatedAt: string;
  isBuiltin: boolean;
}

/**
 * Map the shared base columns of a profile/skill row to their API representation,
 * converting the integer `isBuiltin` flag to a boolean. Generic over the row type
 * so each caller preserves its exact field union types.
 */
export function toBaseProfileFields<R extends BaseProfileRow>(
  row: R
): BaseProfileFieldsResponse {
  return {
    id: row.id,
    projectId: row.projectId,
    userId: row.userId,
    name: row.name,
    description: row.description,
    agentType: row.agentType,
    model: row.model,
    effort: isAgentEffort(row.effort) ? row.effort : DEFAULT_AGENT_EFFORT,
    permissionMode: row.permissionMode,
    systemPromptAppend: row.systemPromptAppend,
    maxTurns: row.maxTurns,
    timeoutMinutes: row.timeoutMinutes,
    vmSizeOverride: row.vmSizeOverride,
    provider: row.provider,
    vmLocation: row.vmLocation,
    workspaceProfile: row.workspaceProfile,
    runtime: isAgentProfileRuntime(row.runtime) ? row.runtime : null,
    devcontainerConfigName: row.devcontainerConfigName,
    taskMode: row.taskMode,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
    isBuiltin: row.isBuiltin === 1,
  };
}

/** Shape accepted by the insert/update helpers — every base field is optional. */
export interface BaseProfileWriteInput {
  description?: string | null;
  agentType?: string;
  model?: string | null;
  effort?: AgentEffort | null;
  permissionMode?: string | null;
  systemPromptAppend?: string | null;
  maxTurns?: number | null;
  timeoutMinutes?: number | null;
  vmSizeOverride?: string | null;
  provider?: string | null;
  vmLocation?: string | null;
  workspaceProfile?: string | null;
  runtime?: AgentProfileRuntime | null;
  devcontainerConfigName?: string | null;
}

/**
 * Build the shared insert column values for a new profile/skill row, applying the
 * `?? null` defaults and resolving the agent type from the request or environment.
 * Callers supply id/projectId/userId/name and any entity-specific columns
 * (taskMode default, resourceRequirementsJson, etc.) separately.
 */
export function baseProfileInsertValues(
  body: BaseProfileWriteInput,
  env: Pick<Env, 'DEFAULT_TASK_AGENT_TYPE'>
) {
  return {
    description: body.description ?? null,
    agentType: body.agentType ?? env.DEFAULT_TASK_AGENT_TYPE ?? 'opencode',
    model: body.model ?? null,
    effort: body.effort ?? DEFAULT_AGENT_EFFORT,
    permissionMode: body.permissionMode ?? null,
    systemPromptAppend: body.systemPromptAppend ?? null,
    maxTurns: body.maxTurns ?? null,
    timeoutMinutes: body.timeoutMinutes ?? null,
    vmSizeOverride: body.vmSizeOverride ?? null,
    provider: body.provider ?? null,
    vmLocation: body.vmLocation ?? null,
    workspaceProfile: body.workspaceProfile ?? null,
    runtime: body.runtime ?? null,
    devcontainerConfigName: body.devcontainerConfigName ?? null,
  };
}

/** Update input adds the renameable `name` and `taskMode` to the base write fields. */
export interface BaseProfileUpdateInput extends BaseProfileWriteInput {
  name?: string;
  taskMode?: string | null;
}

/**
 * Copy any defined base fields from an update request onto a partial update object.
 * Only fields present (`!== undefined`) on the request are applied, preserving the
 * "leave unset columns untouched" semantics. Mutates and returns `updates`.
 */
export function applyBaseProfileUpdates<T extends Record<string, unknown>>(
  updates: T,
  body: BaseProfileUpdateInput
): T {
  const set = updates as Record<string, unknown>;
  if (body.name !== undefined) set.name = body.name.trim();
  if (body.description !== undefined) set.description = body.description;
  if (body.agentType !== undefined) set.agentType = body.agentType;
  if (body.model !== undefined) set.model = body.model;
  if (body.effort !== undefined) set.effort = body.effort ?? DEFAULT_AGENT_EFFORT;
  if (body.permissionMode !== undefined) set.permissionMode = body.permissionMode;
  if (body.systemPromptAppend !== undefined) set.systemPromptAppend = body.systemPromptAppend;
  if (body.maxTurns !== undefined) set.maxTurns = body.maxTurns;
  if (body.timeoutMinutes !== undefined) set.timeoutMinutes = body.timeoutMinutes;
  if (body.vmSizeOverride !== undefined) set.vmSizeOverride = body.vmSizeOverride;
  if (body.provider !== undefined) set.provider = body.provider;
  if (body.vmLocation !== undefined) set.vmLocation = body.vmLocation;
  if (body.workspaceProfile !== undefined) set.workspaceProfile = body.workspaceProfile;
  if (body.runtime !== undefined) set.runtime = body.runtime;
  if (body.devcontainerConfigName !== undefined) set.devcontainerConfigName = body.devcontainerConfigName;
  if (body.taskMode !== undefined) set.taskMode = body.taskMode;
  return updates;
}
