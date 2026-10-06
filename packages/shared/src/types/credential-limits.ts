/**
 * Credential usage-limit read models.
 *
 * Rows originate in D1 `credential_limit_windows` (one row per project ×
 * credential reference × window). The read routes collapse them into one
 * summary per credential so the UI and MCP tools can show "5h 72%, resets
 * 16:40" without knowing the storage layout.
 */

export type CredentialLimitLevel = 'ok' | 'warning' | 'critical' | 'rejected';

export type CredentialLimitStatus = 'allowed' | 'allowed_warning' | 'rejected' | 'unknown';

export type CredentialLimitCredentialSource = 'user' | 'project' | 'platform';

export interface CredentialLimitWindowSummary {
  /** Stable window identifier, e.g. `claude.five_hour`, `codex.primary`, `opencode.weekly`. */
  windowType: string;
  /** Telemetry provider, e.g. `anthropic`, `openai`, `opencode`. */
  provider: string;
  /** Producer of the latest sample, e.g. `claude-acp.rate_limit`, `vm-agent.codex_rollout`. */
  source: string;
  status: CredentialLimitStatus;
  level: CredentialLimitLevel;
  utilizationPercent: number | null;
  limitAmount: number | null;
  remainingAmount: number | null;
  /** Window length when the provider reports one; labels derive from this, not from the key. */
  windowMinutes: number | null;
  /** Epoch ms when the window resets, when known. */
  resetsAt: number | null;
  /** Epoch ms when the provider sample was taken. */
  observedAt: number;
  /** Epoch ms when SAM last wrote this row. */
  updatedAt: number;
}

export interface CredentialLimitCredentialSummary {
  /** Opaque reference such as `cc_credentials:<id>` or `platform_credentials:<id>`. */
  credentialReference: string;
  /** Composable-credential id when the reference points at one, else null. */
  credentialId: string | null;
  credentialSource: CredentialLimitCredentialSource;
  provider: string;
  providerMode: string;
  agentType: string | null;
  /** Worst level across the credential's windows. */
  level: CredentialLimitLevel;
  /** Newest `observedAt` across windows. */
  observedAt: number;
  windows: CredentialLimitWindowSummary[];
}

export interface CredentialLimitsResponse {
  credentials: CredentialLimitCredentialSummary[];
  /** Server time the response was built (epoch ms). */
  generatedAt: number;
}
