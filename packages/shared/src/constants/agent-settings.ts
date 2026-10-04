import type { AgentPermissionMode } from '../types';

// =============================================================================
// Agent Settings
// =============================================================================

/** Valid permission modes for agent sessions.
 * These match the mode IDs reported by claude-agent-acp via ACP NewSession. */
export const VALID_PERMISSION_MODES = [
  'default',
  'acceptEdits',
  'plan',
  'dontAsk',
  'bypassPermissions',
] as const;

/** Permission mode an agent session runs in when no agent profile, project agent
 * default, or user agent setting chooses one. */
export const DEFAULT_AGENT_PERMISSION_MODE: AgentPermissionMode = 'bypassPermissions';

/** Human-readable labels for permission modes. The `default` mode ID is the
 * agent's always-ask mode (Claude Code calls it "Manual"); it is not SAM's
 * default — see DEFAULT_AGENT_PERMISSION_MODE. */
export const AGENT_PERMISSION_MODE_LABELS: Record<AgentPermissionMode, string> = {
  default: 'Manual',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  dontAsk: "Don't Ask",
  bypassPermissions: 'Bypass Permissions',
};
