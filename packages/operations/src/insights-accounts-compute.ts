/**
 * Pure parts of Insights · Accounts (`insights-accounts.ts`): who an account belongs to from the
 * viewer's point of view, how accounts group for display, and how usage-limit waits and rejected
 * windows merge into stall episodes. No I/O here, so every rule is unit-testable on its own.
 */
import {
  PROVIDER_LIMIT_POLICY,
  type ProviderLimitWait,
} from '@simple-agent-manager/scheduler-core';
import type {
  InsightsAccountKind,
  InsightsAccountOwner,
  InsightsStallOutcome,
} from '@simple-agent-manager/shared';

const DAY_MS = 86_400_000;

/** Account identity as one statement row reports it (`ACCOUNT_COLUMNS` in the SQL module). */
export interface AccountMeta {
  /** Credential limit key (the reference, or its digest for a long legacy reference). */
  limitKey: string | null;
  /** The raw reference, when the row carried one (runs do; waits and windows store the key). */
  reference: string | null;
  source: string | null;
  agentType: string | null;
  kind: string | null;
  /** 1 viewer owns the credential, 0 someone else does, null unknown. */
  credOwn: number | null;
  sessionOwn: number | null;
  ownName: string | null;
}

export interface DisplayAccount {
  key: string;
  owner: InsightsAccountOwner;
  kind: InsightsAccountKind;
  agentType: string | null;
  name: string | null;
  /** Set only for the viewer's own credential, for reading its limit windows. */
  ownReference: string | null;
}

const SUBSCRIPTION_KINDS = new Set(['oauth-token', 'auth-json']);
const API_KEY_KINDS = new Set(['api-key', 'openai-compatible']);

export function accountKind(meta: Pick<AccountMeta, 'source' | 'kind'>): InsightsAccountKind {
  if (meta.source === 'platform') return 'platform';
  if (meta.kind && SUBSCRIPTION_KINDS.has(meta.kind)) return 'subscription';
  if (meta.kind && API_KEY_KINDS.has(meta.kind)) return 'api_key';
  return 'unknown';
}

/**
 * The row an account is shown under. The viewer's own credential is its own row, with its name.
 * Anyone else's account is grouped by owner, agent and kind, so neither its name nor its id
 * reaches the response (`routes/chat-agent-credential.ts`: members see the kind of account,
 * never which one).
 */
export function displayAccount(meta: AccountMeta): DisplayAccount {
  const kind = accountKind(meta);
  const agentType = meta.agentType;
  // No credential recorded (a platform session may carry none and is still the platform's).
  if (!meta.limitKey && meta.source !== 'platform') {
    return {
      key: 'not_recorded',
      owner: 'not_recorded',
      kind: 'unknown',
      agentType,
      name: null,
      ownReference: null,
    };
  }
  const credentialId = credentialIdOf(meta.reference ?? meta.limitKey);
  if (meta.credOwn === 1 && credentialId) {
    return {
      key: `cred:${credentialId}`,
      owner: meta.source === 'project' ? 'project' : 'you',
      kind,
      agentType,
      name: meta.ownName,
      ownReference: meta.reference ?? meta.limitKey,
    };
  }
  const owner: InsightsAccountOwner =
    meta.source === 'platform'
      ? 'platform'
      : meta.source === 'project'
        ? 'project'
        : meta.credOwn === null && meta.sessionOwn === 1
          ? 'you'
          : 'teammate';
  return {
    key: `${owner}:${agentType ?? 'unknown'}:${kind}`,
    owner,
    kind,
    agentType,
    name: null,
    ownReference: null,
  };
}

function credentialIdOf(key: string | null): string | null {
  const prefix = 'cc_credentials:';
  if (!key?.startsWith(prefix)) return null;
  const id = key.slice(prefix.length).trim();
  return id.length > 0 ? id : null;
}

/** Fill each field from the first row that knows it. Runs come first, then waits, then windows. */
export function mergeMeta(base: AccountMeta | undefined, next: AccountMeta): AccountMeta {
  if (!base) return next;
  return {
    limitKey: base.limitKey ?? next.limitKey,
    reference: base.reference ?? next.reference,
    source: base.source ?? next.source,
    agentType: base.agentType ?? next.agentType,
    kind: base.kind ?? next.kind,
    credOwn: base.credOwn ?? next.credOwn,
    sessionOwn: base.sessionOwn ?? next.sessionOwn,
    ownName: base.ownName ?? next.ownName,
  };
}

/** One stretch an account could not run: a task's limit wait or a rejected window. */
export interface StallInterval {
  limitKey: string;
  startMs: number;
  endMs: number;
  taskId: string | null;
  window: string | null;
  outcome: InsightsStallOutcome;
}

/**
 * A task's latest limit wait as an interval. Its end is when SAM resumed or let the owner resume
 * it (`ownerOverride.grantedAt`, else `nextRetryAt`), or, for a blocked wait, when the run ended
 * (still going: now). Capped at now and never before its start.
 */
export function waitInterval(
  wait: ProviderLimitWait,
  task: { id: string; terminal: boolean; endedAtMs: number | null },
  nowMs: number
): StallInterval | null {
  if (!wait.credentialKey) return null;
  const start = wait.observedAt;
  let end: number;
  let outcome: InsightsStallOutcome;
  if (wait.phase === 'blocked') {
    end = task.terminal ? (task.endedAtMs ?? nowMs) : nowMs;
    outcome = 'blocked';
  } else {
    end = wait.ownerOverride?.grantedAt ?? wait.nextRetryAt;
    if (task.terminal && task.endedAtMs !== null) end = Math.min(end, task.endedAtMs);
    outcome = wait.phase === 'waiting' && !task.terminal && end > nowMs ? 'ongoing' : 'resumed';
  }
  end = Math.max(start, Math.min(end, nowMs));
  return {
    limitKey: wait.credentialKey,
    startMs: start,
    endMs: end,
    taskId: task.id,
    window: null,
    outcome,
  };
}

/** A rejected window as an interval: from its sample to its reset (unknown reset: still going). */
export function windowInterval(
  row: { limitKey: string; observedAt: number; resetsAt: number | null; window: string },
  nowMs: number
): StallInterval {
  const ongoing = row.resetsAt === null || row.resetsAt > nowMs;
  const end = ongoing ? nowMs : (row.resetsAt as number);
  return {
    limitKey: row.limitKey,
    startMs: row.observedAt,
    endMs: Math.max(row.observedAt, end),
    taskId: null,
    window: row.window,
    outcome: ongoing ? 'ongoing' : 'resumed',
  };
}

export interface StallEpisode {
  limitKey: string;
  startMs: number;
  endMs: number;
  runs: number;
  windows: string[];
  outcome: InsightsStallOutcome;
}

const OUTCOME_RANK: Record<InsightsStallOutcome, number> = { resumed: 0, ongoing: 1, blocked: 2 };

/**
 * Per account, intervals that overlap (or sit within the provider's reset tolerance of each other)
 * are one episode: four agents paused by one exhausted 5-hour window are one stall, not four.
 * Outcome: blocked if any part was blocked, else ongoing if any part still is, else resumed.
 */
export function mergeStallEpisodes(intervals: readonly StallInterval[]): StallEpisode[] {
  const tolerance = PROVIDER_LIMIT_POLICY.resetWindowToleranceMs;
  const byKey = new Map<string, StallInterval[]>();
  for (const interval of intervals) {
    const list = byKey.get(interval.limitKey) ?? [];
    list.push(interval);
    byKey.set(interval.limitKey, list);
  }
  const episodes: StallEpisode[] = [];
  for (const [limitKey, list] of byKey) {
    list.sort((a, b) => a.startMs - b.startMs || a.endMs - b.endMs);
    let current: (StallEpisode & { tasks: Set<string> }) | null = null;
    for (const interval of list) {
      if (current && interval.startMs <= current.endMs + tolerance) {
        current.endMs = Math.max(current.endMs, interval.endMs);
        if (interval.taskId) current.tasks.add(interval.taskId);
        if (interval.window && !current.windows.includes(interval.window)) {
          current.windows.push(interval.window);
        }
        if (OUTCOME_RANK[interval.outcome] > OUTCOME_RANK[current.outcome]) {
          current.outcome = interval.outcome;
        }
        continue;
      }
      if (current) episodes.push(finish(current));
      current = {
        limitKey,
        startMs: interval.startMs,
        endMs: interval.endMs,
        runs: 0,
        windows: interval.window ? [interval.window] : [],
        outcome: interval.outcome,
        tasks: new Set(interval.taskId ? [interval.taskId] : []),
      };
    }
    if (current) episodes.push(finish(current));
  }
  return episodes.sort((a, b) => b.startMs - a.startMs || a.limitKey.localeCompare(b.limitKey));
}

function finish(episode: StallEpisode & { tasks: Set<string> }): StallEpisode {
  const { tasks, ...rest } = episode;
  return { ...rest, runs: tasks.size };
}

/** The start (YYYY-MM-DD) of the day or ISO week (Monday) a day falls in. */
export function bucketStartOf(day: string, bucket: 'day' | 'week'): string {
  if (bucket === 'day') return day;
  const date = new Date(`${day}T00:00:00.000Z`);
  if (!Number.isFinite(date.getTime())) return day;
  return new Date(date.getTime() - ((date.getUTCDay() + 6) % 7) * DAY_MS)
    .toISOString()
    .slice(0, 10);
}
