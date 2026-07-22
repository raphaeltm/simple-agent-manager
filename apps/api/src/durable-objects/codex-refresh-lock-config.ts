/**
 * Configuration constants and storage types for {@link CodexRefreshLock}.
 *
 * Extracted from `codex-refresh-lock.ts` to keep that Durable Object under the
 * 800-line file-size limit (see `.claude/rules/18-file-size-limits.md`). These
 * are pure data declarations — no behavior lives here.
 */

export interface RefreshRequestPayload {
  /** The refresh token sent by Codex. */
  refreshToken: string;
  /** The userId to look up credentials for. */
  userId: string;
  /**
   * Optional projectId — when set, the DO prefers the project-scoped credential
   * row. Preserves scope when rotating OAuth tokens so a project-scoped credential
   * doesn't collapse to user-scoped.
   */
  projectId?: string | null;
}

export interface CodexRefreshEnv {
  DATABASE: D1Database;
  /**
   * Optional observability database for durable auth diagnostics. Present on the
   * full Worker env (DOs share the Worker env); optional here so unit tests can
   * omit it. Family-fatal refresh failures and scope anomalies are persisted
   * through it because Workers Logs are head-sampled (1% in production) and
   * warn/error log lines alone are effectively invisible.
   */
  OBSERVABILITY_DATABASE?: D1Database;
  ENCRYPTION_KEY: string;
  CREDENTIAL_ENCRYPTION_KEY?: string;
  CODEX_REFRESH_UPSTREAM_URL?: string;
  CODEX_REFRESH_UPSTREAM_TIMEOUT_MS?: string;
  CODEX_REFRESH_LOCK_TIMEOUT_MS?: string;
  CODEX_CLIENT_ID?: string;
  /**
   * Comma-separated OAuth scopes that the Codex refresh upstream is expected to
   * return. Scopes outside the allowlist raise a durable diagnostic (alert-only)
   * — they NEVER block persistence of a completed rotation, because the upstream
   * has already consumed the one-time-use refresh token by the time scopes are
   * visible. Empty string disables detection. Unset uses DEFAULT_EXPECTED_SCOPES.
   */
  CODEX_EXPECTED_SCOPES?: string;
  /**
   * Rate limit: max refresh requests per user per window. Defaults to 30.
   */
  RATE_LIMIT_CODEX_REFRESH_PER_HOUR?: string;
  /**
   * Rate limit window in seconds. Defaults to 3600 (1 hour).
   */
  RATE_LIMIT_CODEX_REFRESH_WINDOW_SECONDS?: string;
  /**
   * Grace window (ms) during which a recently-rotated refresh token is still
   * accepted and receives the full token response (including the current
   * refresh_token). Handles the race where Session A rotates the token while
   * Session B still holds the previous one. Defaults to 300000 (5 minutes).
   */
  CODEX_REFRESH_GRACE_WINDOW_MS?: string;
}

export const DEFAULT_UPSTREAM_URL = 'https://auth.openai.com/oauth/token';
export const DEFAULT_UPSTREAM_TIMEOUT_MS = 10_000;
export const DEFAULT_LOCK_TIMEOUT_MS = 30_000;
/**
 * Default OpenAI OAuth client_id for Codex.
 * Override via CODEX_CLIENT_ID Worker secret.
 * This is a public client_id registered with OpenAI — not a secret.
 */
export const DEFAULT_CLIENT_ID = 'app_EMoamEEZ73f0CkXaXp7hrann';
/**
 * Default expected scopes for the Codex OAuth refresh flow. Codex 0.144.x
 * logins request `openid profile email offline_access api.connectors.read
 * api.connectors.invoke` (codex-rs `login/src/server.rs:build_authorize_url`),
 * so refresh responses for current grants echo all six. Scopes outside this
 * allowlist raise a durable diagnostic (provider-drift detection) — they are
 * NEVER a reason to discard the rotated tokens: the upstream consumed the
 * one-time-use refresh token before the scopes were visible, so blocking would
 * strand the token family (root cause of the 2026-07-11 and 2026-07-22 Codex
 * auth incidents; see tasks/archive/2026-07-22-fix-codex-refresh-scope-gate-family-burn.md).
 *
 * Override via CODEX_EXPECTED_SCOPES (comma-separated). Setting the env var
 * to an empty string disables detection.
 */
export const DEFAULT_EXPECTED_SCOPES =
  'openid,profile,email,offline_access,api.connectors.read,api.connectors.invoke';
export const DEFAULT_RATE_LIMIT = 30;
export const DEFAULT_RATE_WINDOW_SECONDS = 3600;
/**
 * Default grace window: 5 minutes. During this window, a refresh token that
 * was recently rotated out (by another session's successful refresh) will still
 * receive the full token response including the current refresh_token. This
 * prevents the race condition where Session B starts with valid tokens, but
 * Session A rotates them before B's first refresh attempt.
 */
export const DEFAULT_GRACE_WINDOW_MS = 300_000;
/**
 * Maximum number of recently-rotated token hashes to track in DO storage.
 * Keeps storage bounded even under pathological refresh patterns.
 */
export const MAX_ROTATED_TOKEN_ENTRIES = 5;

/**
 * A recently-rotated refresh token entry stored in DO storage.
 * We store a SHA-256 hex digest of the old token (not the token itself) so that
 * even if DO storage is compromised, the old tokens cannot be extracted.
 */
export interface RotatedTokenEntry {
  /** SHA-256 hex digest of the old refresh token. */
  tokenHash: string;
  /** Unix timestamp (ms) when the token was rotated out. */
  rotatedAt: number;
}

export interface RateLimitState {
  /** Start of the current window in unix seconds. */
  windowStart: number;
  /** Count of requests in the current window. */
  count: number;
}
