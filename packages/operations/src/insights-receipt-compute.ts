/**
 * Pure arithmetic for the run receipt (`insights-receipt.ts`): phase durations from recorded
 * timestamps, the "what slowed it down" list, and the usual durations of comparable runs.
 * No I/O here, so every rule is unit-tested directly.
 *
 * Phases partition the run's wall-clock time:
 * - `machine`: task created → its workspace was placed on a machine (`workspaces.creating_started_at`,
 *   or the `queued → delegated` status event, whichever is earlier; a restart re-stamps the
 *   former, so the earlier value is the first placement).
 * - `setup`: placed → the agent started (first `→ in_progress` status event, else `tasks.started_at`).
 * - after the agent started, until the run's end, time is split three ways:
 *   - `waiting`: the agent's open questions (`needs_input` attention markers) and asks it filed,
 *     unioned so overlapping questions count once;
 *   - `ci`: from the agent's last message to the final result of the pull request's checks, when
 *     the checks finished later (SAM stores when a check finished, not when it started);
 *   - `agent`: the rest.
 */
import type {
  RunReceiptPhase,
  RunReceiptSlowItem,
  RunReceiptWaitingInterval,
} from '@simple-agent-manager/shared';

import type { InsightsReceiptLimits } from './insights-receipt-settings';

/** D1 stores times as ISO strings or `CURRENT_TIMESTAMP` ("YYYY-MM-DD HH:MM:SS", UTC). */
export function timestampMs(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || value.length === 0) return null;
  const sqlite = /^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}(\.\d+)?$/.test(value);
  const parsed = Date.parse(sqlite ? `${value.replace(' ', 'T')}Z` : value);
  return Number.isFinite(parsed) ? parsed : null;
}

interface Interval {
  start: number;
  end: number;
}

/** Clip to [from, to] and merge overlaps; returns sorted, disjoint intervals. */
export function unionIntervals(intervals: Interval[], from: number, to: number): Interval[] {
  const clipped = intervals
    .map((i) => ({ start: Math.max(i.start, from), end: Math.min(i.end, to) }))
    .filter((i) => i.end > i.start)
    .sort((a, b) => a.start - b.start);
  const merged: Interval[] = [];
  for (const interval of clipped) {
    const last = merged.at(-1);
    if (last && interval.start <= last.end) last.end = Math.max(last.end, interval.end);
    else merged.push({ ...interval });
  }
  return merged;
}

function totalLength(intervals: Interval[]): number {
  return intervals.reduce((sum, i) => sum + (i.end - i.start), 0);
}

function overlapLength(interval: Interval, union: Interval[]): number {
  let overlap = 0;
  for (const other of union) {
    const start = Math.max(interval.start, other.start);
    const end = Math.min(interval.end, other.end);
    if (end > start) overlap += end - start;
  }
  return overlap;
}

export interface ReceiptTimeline {
  createdAt: number;
  machineReadyAt: number | null;
  agentStartAt: number | null;
  /** When the task reached a terminal status; null while it is live. */
  completedAt: number | null;
  live: boolean;
  lastActivityAt: number | null;
  lastAgentMessageAt: number | null;
  /** Last finished check on the pull request's head; null without checks. */
  finalCheckAt: number | null;
  /** True when the run has a pull request with recorded checks, so CI can be measured. */
  hasChecks: boolean;
  waiting: Array<{ startMs: number; endMs: number | null }>;
  now: number;
}

export interface ReceiptPhases {
  phases: RunReceiptPhase[];
  endMs: number;
  totalMs: number;
  waitingMs: number | null;
  setupMs: number | null;
  machineMs: number | null;
  ciMs: number | null;
}

export function computePhases(t: ReceiptTimeline): ReceiptPhases {
  const base =
    t.completedAt ??
    (t.live && t.agentStartAt === null ? t.now : (t.lastActivityAt ?? t.agentStartAt ?? t.now));
  const ciStart = t.lastAgentMessageAt ?? t.agentStartAt;
  const ci =
    t.hasChecks && t.agentStartAt !== null && t.finalCheckAt !== null && ciStart !== null
      ? t.finalCheckAt > ciStart
        ? { start: ciStart, end: t.finalCheckAt }
        : null
      : undefined;
  const endMs = Math.max(base, ci?.end ?? 0, t.createdAt);

  // A run that never got past a phase spent the rest of its life in it: until now while it is
  // live, until it ended (failed or cancelled) otherwise.
  const stoppedAt = t.live ? endMs : t.completedAt;
  const machineEnd = t.machineReadyAt ?? (t.agentStartAt === null ? stoppedAt : null);
  const machineMs = machineEnd === null ? null : Math.max(0, machineEnd - t.createdAt);

  const setupEnd = t.agentStartAt ?? (t.machineReadyAt !== null ? stoppedAt : null);
  const setupMs =
    t.machineReadyAt === null || setupEnd === null
      ? null
      : Math.max(0, setupEnd - Math.max(t.machineReadyAt, t.createdAt));

  let agentMs: number | null = null;
  let waitingMs: number | null = null;
  let ciMs: number | null = null;
  if (t.agentStartAt !== null) {
    const from = t.agentStartAt;
    const waitingUnion = unionIntervals(
      t.waiting.map((w) => ({ start: w.startMs, end: w.endMs ?? endMs })),
      from,
      endMs
    );
    waitingMs = totalLength(waitingUnion);
    if (ci === undefined) ciMs = null;
    else if (ci === null) ciMs = 0;
    else {
      const clipped = unionIntervals([ci], from, endMs);
      ciMs = clipped.reduce(
        (sum, i) => sum + (i.end - i.start) - overlapLength(i, waitingUnion),
        0
      );
    }
    agentMs = Math.max(0, endMs - from - waitingMs - (ciMs ?? 0));
  }

  return {
    phases: [
      { key: 'machine', durationMs: machineMs },
      { key: 'setup', durationMs: setupMs },
      { key: 'agent', durationMs: agentMs },
      { key: 'waiting', durationMs: waitingMs },
      { key: 'ci', durationMs: ciMs },
    ],
    endMs,
    totalMs: Math.max(0, endMs - t.createdAt),
    waitingMs,
    setupMs,
    machineMs,
    ciMs,
  };
}

export function median(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  const upper = sorted[mid] ?? 0;
  return sorted.length % 2 === 1 ? upper : ((sorted[mid - 1] ?? upper) + upper) / 2;
}

export interface UsualDurations {
  comparedBy: 'skill' | 'profile';
  machine: { usualMs: number; sampleSize: number } | null;
  setup: { usualMs: number; sampleSize: number } | null;
}

export interface ComparableRun {
  createdAt: number | null;
  machineReadyAt: number | null;
  agentStartAt: number | null;
}

/** Usual machine wait and setup across comparable runs; null for a phase with too few samples. */
export function usualDurations(
  runs: ComparableRun[],
  comparedBy: 'skill' | 'profile',
  minRuns: number
): UsualDurations {
  const machine: number[] = [];
  const setup: number[] = [];
  for (const run of runs) {
    if (
      run.createdAt !== null &&
      run.machineReadyAt !== null &&
      run.machineReadyAt >= run.createdAt
    )
      machine.push(run.machineReadyAt - run.createdAt);
    if (
      run.machineReadyAt !== null &&
      run.agentStartAt !== null &&
      run.agentStartAt >= run.machineReadyAt
    )
      setup.push(run.agentStartAt - run.machineReadyAt);
  }
  const pick = (values: number[]) => {
    const usual = values.length >= minRuns ? median(values) : null;
    return usual === null ? null : { usualMs: usual, sampleSize: values.length };
  };
  return { comparedBy, machine: pick(machine), setup: pick(setup) };
}

const QUESTION_MAX_CHARS = 160;
const SLOWED_DOWN_MAX = 3;

function slowItem(
  partial: Partial<RunReceiptSlowItem> & Pick<RunReceiptSlowItem, 'kind'>
): RunReceiptSlowItem {
  return {
    durationMs: null,
    usualMs: null,
    comparedBy: null,
    sampleSize: null,
    question: null,
    peakMemoryBytes: null,
    requestedMemoryMb: null,
    count: null,
    ...partial,
  };
}

export interface SlowInputs {
  phases: ReceiptPhases;
  usual: UsualDurations | null;
  waiting: RunReceiptWaitingInterval[];
  askTitles: Array<{ startMs: number; endMs: number | null; title: string | null }>;
  checks: 'success' | 'failure' | 'pending' | 'neutral' | null;
  peakMemoryBytes: number | null;
  requestedMemoryMb: number | null;
  oomKills: number;
}

/**
 * Up to three reasons the run took longer, the largest delay first. A phase is only called slow
 * against the usual duration of comparable runs; without enough of them it is not listed.
 */
export function slowedDown(input: SlowInputs, limits: InsightsReceiptLimits): RunReceiptSlowItem[] {
  const minMs = limits.receiptSlowMinSeconds * 1000;
  const factor = limits.receiptSlowFactorPercent / 100;
  const timed: RunReceiptSlowItem[] = [];

  for (const kind of ['machine', 'setup'] as const) {
    const durationMs = kind === 'machine' ? input.phases.machineMs : input.phases.setupMs;
    const usual = input.usual?.[kind] ?? null;
    if (durationMs === null || usual === null || durationMs < minMs) continue;
    if (durationMs < usual.usualMs * factor) continue;
    timed.push(
      slowItem({
        kind,
        durationMs,
        usualMs: usual.usualMs,
        comparedBy: input.usual?.comparedBy ?? null,
        sampleSize: usual.sampleSize,
      })
    );
  }

  const waitingMs = input.phases.waitingMs;
  if (waitingMs !== null && waitingMs >= minMs) {
    const now = input.phases.endMs;
    const questions = [
      ...input.waiting.map((w) => ({ start: w.startMs, end: w.endMs ?? now, text: w.reason })),
      ...input.askTitles.map((a) => ({ start: a.startMs, end: a.endMs ?? now, text: a.title })),
    ].sort((a, b) => b.end - b.start - (a.end - a.start) || a.start - b.start);
    const text = questions.find((q) => q.text && q.text.trim().length > 0)?.text?.trim() ?? null;
    timed.push(
      slowItem({
        kind: 'waiting',
        durationMs: waitingMs,
        question:
          text && text.length > QUESTION_MAX_CHARS
            ? `${text.slice(0, QUESTION_MAX_CHARS - 1)}…`
            : text,
      })
    );
  }

  if (input.checks === 'failure') {
    timed.push(slowItem({ kind: 'ci_failing', durationMs: input.phases.ciMs }));
  }

  timed.sort((a, b) => (b.durationMs ?? 0) - (a.durationMs ?? 0));

  const resources: RunReceiptSlowItem[] = [];
  if (input.oomKills > 0) resources.push(slowItem({ kind: 'oom', count: input.oomKills }));
  if (
    input.peakMemoryBytes !== null &&
    input.requestedMemoryMb !== null &&
    input.requestedMemoryMb > 0 &&
    input.peakMemoryBytes >=
      input.requestedMemoryMb * 1024 * 1024 * (limits.receiptMemoryNearLimitPercent / 100)
  ) {
    resources.push(
      slowItem({
        kind: 'memory',
        peakMemoryBytes: input.peakMemoryBytes,
        requestedMemoryMb: input.requestedMemoryMb,
      })
    );
  }

  return [...timed, ...resources].slice(0, SLOWED_DOWN_MAX);
}
