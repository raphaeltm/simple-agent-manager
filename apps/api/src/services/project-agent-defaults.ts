/**
 * Project agent defaults resolver.
 *
 * Reads the project.agentDefaults JSON column and extracts the model and
 * permission mode overrides for a specific agent type. Invalid JSON or
 * missing entries return nulls so callers can fall through to user-level
 * agent settings (or platform defaults).
 *
 * Resolution chain (see spec 022 / multi-level config override idea):
 *   task explicit > agent profile > project.agentDefaults[agentType] >
 *   user agent_settings > platform default
 */
import type { AgentPermissionMode, AgentType, ProjectAgentDefaults } from '@simple-agent-manager/shared';
import { VALID_PERMISSION_MODES } from '@simple-agent-manager/shared';

export interface ResolvedProjectAgentDefault {
  model: string | null;
  permissionMode: AgentPermissionMode | null;
}

/**
 * Parse a raw JSON string (from the D1 `agent_defaults` column) and return the
 * per-agent-type override. Returns `{ model: null, permissionMode: null }` when
 * the JSON is missing, malformed, or has no entry for the requested agent type.
 */
export function resolveProjectAgentDefault(
  rawAgentDefaults: string | null | undefined,
  agentType: AgentType | string | null | undefined
): ResolvedProjectAgentDefault {
  const empty: ResolvedProjectAgentDefault = { model: null, permissionMode: null };
  if (!rawAgentDefaults || !agentType) return empty;

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawAgentDefaults);
  } catch {
    return empty;
  }

  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return empty;

  const map = parsed as ProjectAgentDefaults;
  const entry = map[agentType as AgentType];
  if (!entry || typeof entry !== 'object') return empty;

  const model = typeof entry.model === 'string' && entry.model.length > 0 ? entry.model : null;
  const permissionMode =
    typeof entry.permissionMode === 'string' &&
    (VALID_PERMISSION_MODES as readonly string[]).includes(entry.permissionMode)
      ? (entry.permissionMode as AgentPermissionMode)
      : null;

  return { model, permissionMode };
}
