/**
 * Pure helpers for presenting credential usage-limit windows.
 *
 * Shared by the web UI and the MCP `get_credential_limits` tool so both label
 * a window the same way. Labels derive from the window length the provider
 * reported, never from a window's position (primary/secondary): Codex plans
 * order windows differently (team: 5h primary + weekly secondary; prolite:
 * weekly primary only), see `.claude/rules/74-proxy-signals-must-match-the-condition.md`.
 */

import type { CredentialLimitLevel } from './types/credential-limits';

const CREDENTIAL_LIMIT_LEVEL_RANK: Record<CredentialLimitLevel, number> = {
  ok: 0,
  warning: 1,
  critical: 2,
  rejected: 3,
};

const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 24 * MINUTES_PER_HOUR;
const MINUTES_PER_WEEK = 7 * MINUTES_PER_DAY;

/** Prefix of a composable-credential reference, e.g. `cc_credentials:<id>`. */
const CC_CREDENTIAL_REFERENCE_PREFIX = 'cc_credentials:';

const FIXED_WINDOW_LABELS: Record<string, string> = {
  'claude.five_hour': '5h',
  'claude.seven_day': 'Week',
  'claude.seven_day_opus': 'Opus week',
  'claude.seven_day_sonnet': 'Sonnet week',
  'opencode.rolling': 'Rolling',
  'opencode.weekly': 'Week',
  'opencode.monthly': 'Month',
  'anthropic.requests': 'Requests',
  'anthropic.tokens': 'Tokens',
  'anthropic.input-tokens': 'Input tokens',
  'anthropic.output-tokens': 'Output tokens',
  'anthropic.priority-input-tokens': 'Priority input tokens',
  'anthropic.priority-output-tokens': 'Priority output tokens',
  'openai.requests': 'Requests',
  'openai.tokens': 'Tokens',
  'openai.project-tokens': 'Project tokens',
};

const FAMILY_LABELS: Record<string, string> = {
  claude: 'Claude',
  codex: 'Codex',
  opencode: 'OpenCode',
  anthropic: 'Anthropic API',
  openai: 'OpenAI API',
};

export function worstCredentialLimitLevel(
  levels: Iterable<CredentialLimitLevel | null | undefined>
): CredentialLimitLevel {
  let worst: CredentialLimitLevel = 'ok';
  for (const level of levels) {
    if (!level || !(level in CREDENTIAL_LIMIT_LEVEL_RANK)) continue;
    if (CREDENTIAL_LIMIT_LEVEL_RANK[level] > CREDENTIAL_LIMIT_LEVEL_RANK[worst]) worst = level;
  }
  return worst;
}

/** Extract the composable-credential id from a `cc_credentials:<id>` reference. */
export function credentialIdFromReference(reference: string): string | null {
  if (!reference.startsWith(CC_CREDENTIAL_REFERENCE_PREFIX)) return null;
  const id = reference.slice(CC_CREDENTIAL_REFERENCE_PREFIX.length).trim();
  return id.length > 0 ? id : null;
}

/** Human label for the window family encoded in the window type prefix. */
export function credentialLimitFamilyLabel(windowType: string): string {
  const family = windowType.split('.')[0] ?? '';
  return FAMILY_LABELS[family] ?? family ?? 'Provider';
}

/** Format a window length as a short label, e.g. 300 → `5h`, 10080 → `Week`. */
export function formatCredentialLimitWindowMinutes(windowMinutes: number): string {
  if (!Number.isFinite(windowMinutes) || windowMinutes <= 0) return 'Window';
  if (windowMinutes === MINUTES_PER_WEEK) return 'Week';
  if (windowMinutes < MINUTES_PER_HOUR) return `${Math.round(windowMinutes)}m`;
  if (windowMinutes < MINUTES_PER_DAY) return `${Math.round(windowMinutes / MINUTES_PER_HOUR)}h`;
  if (windowMinutes % MINUTES_PER_DAY === 0) return `${windowMinutes / MINUTES_PER_DAY}d`;
  return `${Math.round(windowMinutes / MINUTES_PER_HOUR)}h`;
}

/**
 * Nominal span of fixed-meaning window types whose provider payload carries no
 * length (OpenCode Go reports only `resetsAt`). Used ONLY to order a credential's
 * windows shortest-first; never for labels, thresholds or gates. Positional types
 * (`codex.primary`/`secondary`) and token-rate windows stay unknown.
 */
const NOMINAL_WINDOW_MINUTES: Record<string, number> = {
  'claude.five_hour': 5 * 60,
  'claude.seven_day': 7 * 24 * 60,
  'claude.seven_day_opus': 7 * 24 * 60,
  'claude.seven_day_sonnet': 7 * 24 * 60,
  'opencode.rolling': 5 * 60,
  'opencode.weekly': 7 * 24 * 60,
  'opencode.monthly': 30 * 24 * 60,
};

/**
 * Span to sort a window by: the reported length when the provider gave one,
 * otherwise the nominal span of a fixed-meaning type, otherwise `null` (sort last).
 */
export function credentialLimitWindowSortMinutes(
  windowType: string,
  windowMinutes: number | null | undefined
): number | null {
  if (windowMinutes !== null && windowMinutes !== undefined) return windowMinutes;
  return NOMINAL_WINDOW_MINUTES[windowType] ?? null;
}

/**
 * Label for one window. Fixed-meaning window types use a fixed label; positional
 * types (`codex.primary`, `codex.secondary`) are labelled by their reported length.
 */
export function credentialLimitWindowLabel(
  windowType: string,
  windowMinutes: number | null | undefined
): string {
  const fixed = FIXED_WINDOW_LABELS[windowType];
  if (fixed) return fixed;
  if (windowMinutes !== null && windowMinutes !== undefined) {
    return formatCredentialLimitWindowMinutes(windowMinutes);
  }
  const suffix = windowType.split('.').slice(1).join('.');
  return suffix ? suffix.replace(/[_-]+/g, ' ') : 'Window';
}
