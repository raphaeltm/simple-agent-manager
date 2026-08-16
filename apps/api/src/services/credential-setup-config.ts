/**
 * Configuration readers for guided agent-credential setup
 * (Cloudflare Sandbox). All values are env-configurable with a `DEFAULT_*`
 * constant fallback (Constitution Principle XI — no hardcoded limits/timeouts).
 */
import type { Env } from '../env';

/** Concurrency sub-cap for simultaneous setup sessions (below the Sandbox container max_instances). */
export const DEFAULT_MAX_CONCURRENT_SETUP_SESSIONS = 2;
/** Setup session lifetime before auto-teardown (15 min). */
export const DEFAULT_SETUP_SESSION_TTL_MS = 15 * 60_000;
/** credential capture poll interval. */
export const DEFAULT_SETUP_SESSION_CAPTURE_POLL_MS = 3_000;
/** Max expired/orphaned sessions torn down per cron sweep (bounded — rule 47). */
export const DEFAULT_SETUP_SESSION_SWEEP_MAX_CANDIDATES = 50;
/**
 * Extra grace beyond the session TTL before a pool lease is considered leaked
 * and self-pruned. Guards against a slot being permanently consumed by a
 * session whose DO died without releasing (rule 47 escape path).
 */
export const DEFAULT_POOL_LEASE_BUFFER_MS = 5 * 60_000;
export const DEFAULT_CLAUDE_SETUP_VERIFICATION_POLL_MS = 500;
export const DEFAULT_CLAUDE_SETUP_TTY_COLUMNS = 512;
export const DEFAULT_CLAUDE_SETUP_OUTPUT_BUFFER_BYTES = 32_768;
export const DEFAULT_CLAUDE_VERIFICATION_CODE_MAX_LENGTH = 1_024;
export const DEFAULT_CLAUDE_SETUP_ERROR_DETAIL_MAX_LENGTH = 160;
export const DEFAULT_CLAUDE_OAUTH_TOKEN_MAX_LENGTH = 8_192;

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(raw ?? '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export function getMaxConcurrentSetupSessions(env: Env): number {
  return parsePositiveInt(env.MAX_CONCURRENT_SETUP_SESSIONS, DEFAULT_MAX_CONCURRENT_SETUP_SESSIONS);
}

export function getSetupSessionTtlMs(env: Env): number {
  return parsePositiveInt(env.SETUP_SESSION_TTL_MS, DEFAULT_SETUP_SESSION_TTL_MS);
}

export function getSetupSessionCapturePollMs(env: Env): number {
  return parsePositiveInt(env.SETUP_SESSION_CAPTURE_POLL_MS, DEFAULT_SETUP_SESSION_CAPTURE_POLL_MS);
}

export function getSetupSessionSweepMaxCandidates(env: Env): number {
  return parsePositiveInt(
    env.SETUP_SESSION_SWEEP_MAX_CANDIDATES,
    DEFAULT_SETUP_SESSION_SWEEP_MAX_CANDIDATES
  );
}

export function getPoolLeaseBufferMs(env: Env): number {
  return parsePositiveInt(env.POOL_LEASE_BUFFER_MS, DEFAULT_POOL_LEASE_BUFFER_MS);
}

export function getClaudeSetupVerificationPollMs(env: Env): number {
  return parsePositiveInt(
    env.CLAUDE_SETUP_VERIFICATION_POLL_MS,
    DEFAULT_CLAUDE_SETUP_VERIFICATION_POLL_MS
  );
}

export function getClaudeSetupTtyColumns(env: Env): number {
  return parsePositiveInt(env.CLAUDE_SETUP_TTY_COLUMNS, DEFAULT_CLAUDE_SETUP_TTY_COLUMNS);
}

export function getClaudeSetupOutputBufferBytes(env: Env): number {
  return parsePositiveInt(
    env.CLAUDE_SETUP_OUTPUT_BUFFER_BYTES,
    DEFAULT_CLAUDE_SETUP_OUTPUT_BUFFER_BYTES
  );
}

export function getClaudeVerificationCodeMaxLength(env: Env): number {
  return parsePositiveInt(
    env.CLAUDE_VERIFICATION_CODE_MAX_LENGTH,
    DEFAULT_CLAUDE_VERIFICATION_CODE_MAX_LENGTH
  );
}

export function getClaudeSetupErrorDetailMaxLength(env: Env): number {
  return parsePositiveInt(
    env.CLAUDE_SETUP_ERROR_DETAIL_MAX_LENGTH,
    DEFAULT_CLAUDE_SETUP_ERROR_DETAIL_MAX_LENGTH
  );
}

export function getClaudeOauthTokenMaxLength(env: Env): number {
  return parsePositiveInt(env.CLAUDE_OAUTH_TOKEN_MAX_LENGTH, DEFAULT_CLAUDE_OAUTH_TOKEN_MAX_LENGTH);
}

/** Lease age after which the pool self-prunes a leaked lease (TTL + buffer). */
export function getPoolLeaseMaxAgeMs(env: Env): number {
  return getSetupSessionTtlMs(env) + getPoolLeaseBufferMs(env);
}

/**
 * Statuses that count as "active" (occupying the one-active-per-user slot and a
 * pool lease). Mirrors the partial unique index updated in migration 0112.
 */
export const ACTIVE_SETUP_STATUSES = [
  'creating',
  'admitting',
  'provisioning',
  'waiting_for_user',
  'exchanging',
  'capturing',
  'saving',
] as const;

export type SetupSessionStatus =
  | (typeof ACTIVE_SETUP_STATUSES)[number]
  | 'completed'
  | 'failed'
  | 'cancelled'
  | 'expired';

export function isTerminalSetupStatus(status: string): boolean {
  return (
    status === 'completed' || status === 'failed' || status === 'cancelled' || status === 'expired'
  );
}
