/**
 * Storage form of a model selection layer (projects, agent_profiles, skills `agent_models_json`).
 * Kept free of heavy imports: profile and skill field mappers use it on every read.
 */
import {
  AGENT_MODEL_SELECTION_MAX,
  type AgentModelSelection,
  isAgentModelId,
} from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';

const log = createModuleLogger('agent_models.selection');

/**
 * Read a stored selection column. NULL inherits. A value that is not a JSON array of model ids
 * can only come from a hand edit; it fails closed as "no models" and is logged, so a corrupt
 * row can never widen access.
 */
export function parseStoredAgentModelSelection(
  raw: string | null | undefined,
  context: { table: string; id: string }
): AgentModelSelection {
  if (raw === null || raw === undefined) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (Array.isArray(value) && value.every(isAgentModelId)) {
      return [...new Set(value)].slice(0, AGENT_MODEL_SELECTION_MAX);
    }
  } catch {
    // fall through to the logged fail-closed result
  }
  log.error('invalid_stored_selection', { ...context, action: 'treated_as_no_models' });
  return [];
}

/** Serialize a validated selection for storage; null keeps the inherit meaning. */
export function serializeAgentModelSelection(selection: readonly string[] | null): string | null {
  if (selection === null) return null;
  return JSON.stringify([...new Set(selection)].sort());
}

/** API shape of a stored layer: a fresh mutable array or null. */
export function agentModelsResponse(
  raw: string | null | undefined,
  context: { table: string; id: string }
): string[] | null {
  const selection = parseStoredAgentModelSelection(raw, context);
  return selection === null ? null : [...selection];
}
