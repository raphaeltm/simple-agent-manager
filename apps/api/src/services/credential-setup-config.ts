/**
 * Configuration readers for the guided agent-credential setup terminal
 * (Cloudflare Sandbox). All values are env-configurable with a `DEFAULT_*`
 * constant fallback (Constitution Principle XI — no hardcoded limits/timeouts).
 */
import type { Env } from '../env';

/** Concurrency sub-cap for simultaneous setup sessions (below the Sandbox container max_instances). */
export const DEFAULT_MAX_CONCURRENT_SETUP_SESSIONS = 2;
/** Setup session lifetime before auto-teardown (15 min). */
export const DEFAULT_SETUP_SESSION_TTL_MS = 15 * 60_000;
/** auth.json capture poll interval. */
export const DEFAULT_SETUP_SESSION_CAPTURE_POLL_MS = 3_000;
/** Max expired/orphaned sessions torn down per cron sweep (bounded — rule 47). */
export const DEFAULT_SETUP_SESSION_SWEEP_MAX_CANDIDATES = 50;
/**
 * Extra grace beyond the session TTL before a pool lease is considered leaked
 * and self-pruned. Guards against a slot being permanently consumed by a
 * session whose DO died without releasing (rule 47 escape path).
 */
export const DEFAULT_POOL_LEASE_BUFFER_MS = 5 * 60_000;

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

/** Lease age after which the pool self-prunes a leaked lease (TTL + buffer). */
export function getPoolLeaseMaxAgeMs(env: Env): number {
  return getSetupSessionTtlMs(env) + DEFAULT_POOL_LEASE_BUFFER_MS;
}

/**
 * The guided Codex setup terminal is default-OFF. It additionally requires the
 * Sandbox runtime (`SANDBOX_ENABLED`) — see requireSandbox().
 */
export function isCodexSetupTerminalEnabled(env: Env): boolean {
  return env.CODEX_SETUP_TERMINAL_ENABLED === 'true';
}

/**
 * Statuses that count as "active" (occupying the one-active-per-user slot and a
 * pool lease). Mirrors the partial unique index in migration 0097.
 */
export const ACTIVE_SETUP_STATUSES = [
  'creating',
  'admitting',
  'provisioning',
  'waiting_for_user',
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
    status === 'completed' ||
    status === 'failed' ||
    status === 'cancelled' ||
    status === 'expired'
  );
}
