/**
 * Shared helpers for the trial onboarding routes.
 *
 * Kept in a single module so create.ts / status.ts / waitlist.ts share the
 * same month-key math, repo-URL canonicalisation, and env-var fallback
 * constants (Principle XI — no hardcoded values; every limit has a
 * DEFAULT_* constant and an env override).
 */
import type { Env } from '../../env';

// ---------------------------------------------------------------------------
// Defaults (Principle XI)
// ---------------------------------------------------------------------------

/** Monthly cap on anonymous trial creations. */
export const DEFAULT_TRIAL_MONTHLY_CAP = 1500;
/** Trial workspace TTL in ms (20 min). */
export const DEFAULT_TRIAL_WORKSPACE_TTL_MS = 20 * 60 * 1000;
/** GitHub repo size upper bound in KB (GitHub `size` field is reported in KB). */
export const DEFAULT_TRIAL_REPO_MAX_KB = 500 * 1024; // 500 MB
/** Timeout for the GitHub repo metadata probe. */
export const DEFAULT_TRIAL_GITHUB_TIMEOUT_MS = 5_000;
/** Retention window (hours) after which expired/failed/claimed trials are reaped. */
export const DEFAULT_TRIAL_DATA_RETENTION_HOURS = 24 * 7; // 7 days
/** Stale-counter months to keep in TrialCounter DO SQLite. */
export const DEFAULT_TRIAL_COUNTER_KEEP_MONTHS = 3;
/** How long to wait after the reset date before purging notified waitlist rows. */
export const DEFAULT_TRIAL_WAITLIST_PURGE_DAYS = 30;

// ---------------------------------------------------------------------------
// Env var resolution
// ---------------------------------------------------------------------------

export function resolveMonthlyCap(env: Env): number {
  const raw = env.TRIAL_MONTHLY_CAP;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TRIAL_MONTHLY_CAP;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_TRIAL_MONTHLY_CAP;
}

export function resolveWorkspaceTtlMs(env: Env): number {
  const raw = env.TRIAL_WORKSPACE_TTL_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TRIAL_WORKSPACE_TTL_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TRIAL_WORKSPACE_TTL_MS;
}

export function resolveRepoMaxKb(env: Env): number {
  const raw = env.TRIAL_REPO_MAX_KB;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TRIAL_REPO_MAX_KB;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_TRIAL_REPO_MAX_KB;
}

export function resolveGithubTimeoutMs(env: Env): number {
  const raw = env.TRIAL_GITHUB_TIMEOUT_MS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TRIAL_GITHUB_TIMEOUT_MS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TRIAL_GITHUB_TIMEOUT_MS;
}

export function resolveRetentionHours(env: Env): number {
  const raw = env.TRIAL_DATA_RETENTION_HOURS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TRIAL_DATA_RETENTION_HOURS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_TRIAL_DATA_RETENTION_HOURS;
}

export function resolveCounterKeepMonths(env: Env): number {
  const raw = env.TRIAL_COUNTER_KEEP_MONTHS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TRIAL_COUNTER_KEEP_MONTHS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TRIAL_COUNTER_KEEP_MONTHS;
}

export function resolveWaitlistPurgeDays(env: Env): number {
  const raw = env.TRIAL_WAITLIST_PURGE_DAYS;
  if (raw === undefined || raw === null || raw === '') {
    return DEFAULT_TRIAL_WAITLIST_PURGE_DAYS;
  }
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? Math.floor(parsed)
    : DEFAULT_TRIAL_WAITLIST_PURGE_DAYS;
}

// ---------------------------------------------------------------------------
// Month key math (UTC)
// ---------------------------------------------------------------------------

/** `YYYY-MM` (UTC) for `now` — matches TrialCounter keyspace. */
export function currentMonthKey(now: number = Date.now()): string {
  const d = new Date(now);
  const y = d.getUTCFullYear();
  const m = d.getUTCMonth() + 1;
  return `${y}-${m.toString().padStart(2, '0')}`;
}

/** ISO date (YYYY-MM-01) of the first day of the next UTC month. */
export function nextMonthResetDate(now: number = Date.now()): string {
  const d = new Date(now);
  const next = new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1));
  const y = next.getUTCFullYear();
  const m = next.getUTCMonth() + 1;
  return `${y}-${m.toString().padStart(2, '0')}-01`;
}

/**
 * Shift a month key by `delta` months (negative = earlier). Used by the
 * monthly rollover audit to compute the oldest key we want to retain.
 */
export function shiftMonthKey(monthKey: string, delta: number): string {
  const match = /^(\d{4})-(\d{2})$/.exec(monthKey);
  if (!match) throw new Error(`invalid month key: ${monthKey}`);
  const y = Number(match[1]);
  const m = Number(match[2]);
  // JS Date handles month overflow/underflow cleanly.
  const d = new Date(Date.UTC(y, m - 1 + delta, 1));
  const ny = d.getUTCFullYear();
  const nm = d.getUTCMonth() + 1;
  return `${ny}-${nm.toString().padStart(2, '0')}`;
}

// ---------------------------------------------------------------------------
// GitHub repo URL canonicalisation
// ---------------------------------------------------------------------------

export interface ParsedRepoUrl {
  owner: string;
  name: string;
  canonical: string; // https://github.com/owner/name
}

/**
 * Parse a GitHub public-repo URL. Accepts the forms matched by
 * GITHUB_REPO_URL_REGEX in the shared Valibot schema; strips `.git` and
 * trailing slashes. Returns null on structural mismatch — the route
 * should already have validated the shape; this is a defense-in-depth parse.
 */
export function parseGithubRepoUrl(url: string): ParsedRepoUrl | null {
  const trimmed = url.trim().replace(/\/+$/, '').replace(/\.git$/, '');
  const match =
    /^https:\/\/github\.com\/([A-Za-z0-9](?:[A-Za-z0-9-]{0,37}[A-Za-z0-9])?)\/([A-Za-z0-9_.-]{1,100})$/.exec(
      trimmed
    );
  if (!match) return null;
  const owner = match[1]!;
  const name = match[2]!;
  return { owner, name, canonical: `https://github.com/${owner}/${name}` };
}

// ---------------------------------------------------------------------------
// TrialCounter DO access
// ---------------------------------------------------------------------------

/** Return the singleton `TrialCounter` stub (keyed by `global`). */
export function getTrialCounterStub(env: Env): DurableObjectStub {
  const id = env.TRIAL_COUNTER.idFromName('global');
  return env.TRIAL_COUNTER.get(id);
}
