// =============================================================================
// Agent Settings
// =============================================================================

/** Valid permission modes for agent sessions.
 * These match the mode IDs reported by claude-agent-acp via ACP NewSession. */
export const VALID_PERMISSION_MODES = ['default', 'acceptEdits', 'plan', 'dontAsk', 'bypassPermissions'] as const;

/** Human-readable labels for permission modes */
export const AGENT_PERMISSION_MODE_LABELS: Record<string, string> = {
  default: 'Default',
  acceptEdits: 'Accept Edits',
  plan: 'Plan Mode',
  dontAsk: "Don't Ask",
  bypassPermissions: 'Bypass Permissions',
};

/** Human-readable descriptions for permission modes */
export const AGENT_PERMISSION_MODE_DESCRIPTIONS: Record<string, string> = {
  default: 'Standard behavior, prompts for dangerous operations',
  acceptEdits: 'Auto-accept file edit operations',
  plan: 'Planning mode, no actual tool execution',
  dontAsk: "Don't prompt for permissions, deny if not pre-approved",
  bypassPermissions: 'Bypass all permission checks',
};
