import { describe, expect, it } from 'vitest';

import {
  computePhases,
  median,
  type ReceiptTimeline,
  slowedDown,
  timestampMs,
  unionIntervals,
  usualDurations,
} from '../../src/insights-receipt-compute';
import { defaultInsightsReceiptLimits } from '../../src/insights-receipt-settings';

const MIN = 60_000;
const T0 = 1_794_000_000_000;
const limits = defaultInsightsReceiptLimits();

function timeline(overrides: Partial<ReceiptTimeline> = {}): ReceiptTimeline {
  return {
    createdAt: T0,
    machineReadyAt: T0 + MIN,
    agentStartAt: T0 + 4 * MIN,
    completedAt: T0 + 40 * MIN,
    live: false,
    lastActivityAt: T0 + 30 * MIN,
    lastAgentMessageAt: T0 + 30 * MIN,
    finalCheckAt: T0 + 38 * MIN,
    hasChecks: true,
    waiting: [{ startMs: T0 + 10 * MIN, endMs: T0 + 15 * MIN }],
    now: T0 + 60 * MIN,
    ...overrides,
  };
}

const durations = (t: ReceiptTimeline) =>
  Object.fromEntries(computePhases(t).phases.map((p) => [p.key, p.durationMs]));

describe('timestampMs', () => {
  it('reads ISO, CURRENT_TIMESTAMP (as UTC) and epoch values, and rejects garbage', () => {
    expect(timestampMs('2026-11-16T09:00:00.000Z')).toBe(Date.parse('2026-11-16T09:00:00.000Z'));
    expect(timestampMs('2026-11-16 09:00:00')).toBe(Date.parse('2026-11-16T09:00:00Z'));
    expect(timestampMs(T0)).toBe(T0);
    expect(timestampMs('soon')).toBeNull();
    expect(timestampMs(null)).toBeNull();
    expect(timestampMs(Number.NaN)).toBeNull();
  });
});

describe('unionIntervals', () => {
  it('clips to the window and merges overlaps so shared time counts once', () => {
    expect(
      unionIntervals(
        [
          { start: 0, end: 10 },
          { start: 5, end: 20 },
          { start: 30, end: 40 },
          { start: -5, end: 1 },
        ],
        0,
        35
      )
    ).toEqual([
      { start: 0, end: 20 },
      { start: 30, end: 35 },
    ]);
  });
});

describe('computePhases', () => {
  it('partitions a finished run into machine, setup, agent, waiting and CI', () => {
    expect(durations(timeline())).toEqual({
      machine: MIN,
      setup: 3 * MIN,
      agent: 36 * MIN - 5 * MIN - 8 * MIN,
      waiting: 5 * MIN,
      ci: 8 * MIN,
    });
    const result = computePhases(timeline());
    expect(result.totalMs).toBe(40 * MIN);
    // The phases add up to the run's total.
    expect(result.phases.reduce((sum, p) => sum + (p.durationMs ?? 0), 0)).toBe(result.totalMs);
  });

  it('counts overlapping questions once and does not count CI time spent waiting twice', () => {
    const result = durations(
      timeline({
        waiting: [
          { startMs: T0 + 10 * MIN, endMs: T0 + 15 * MIN },
          { startMs: T0 + 12 * MIN, endMs: T0 + 20 * MIN },
          { startMs: T0 + 35 * MIN, endMs: T0 + 37 * MIN },
        ],
      })
    );
    expect(result.waiting).toBe(10 * MIN + 2 * MIN);
    expect(result.ci).toBe(8 * MIN - 2 * MIN);
    expect(result.agent).toBe(36 * MIN - 12 * MIN - 6 * MIN);
  });

  it('extends the run to a check that finished after the task completed', () => {
    const result = computePhases(timeline({ finalCheckAt: T0 + 45 * MIN }));
    expect(result.totalMs).toBe(45 * MIN);
    expect(durations(timeline({ finalCheckAt: T0 + 45 * MIN })).ci).toBe(15 * MIN);
  });

  it('reports no CI phase without checks, and zero when checks finished before the agent stopped', () => {
    expect(durations(timeline({ hasChecks: false, finalCheckAt: null })).ci).toBeNull();
    expect(durations(timeline({ finalCheckAt: T0 + 20 * MIN })).ci).toBe(0);
  });

  it('counts a live run still waiting for a machine up to now, with later phases unmeasured', () => {
    expect(
      durations(
        timeline({
          live: true,
          completedAt: null,
          machineReadyAt: null,
          agentStartAt: null,
          lastActivityAt: null,
          lastAgentMessageAt: null,
          hasChecks: false,
          finalCheckAt: null,
          waiting: [],
        })
      )
    ).toEqual({ machine: 60 * MIN, setup: null, agent: null, waiting: null, ci: null });
  });

  it('charges a run that failed during setup with setup until it ended', () => {
    expect(
      durations(
        timeline({
          agentStartAt: null,
          completedAt: T0 + 9 * MIN,
          lastActivityAt: null,
          lastAgentMessageAt: null,
          hasChecks: false,
          finalCheckAt: null,
          waiting: [],
        })
      )
    ).toEqual({ machine: MIN, setup: 8 * MIN, agent: null, waiting: null, ci: null });
  });

  it('counts an open question up to the end of the run', () => {
    expect(
      durations(
        timeline({
          live: true,
          completedAt: null,
          lastActivityAt: T0 + 30 * MIN,
          hasChecks: false,
          finalCheckAt: null,
          waiting: [{ startMs: T0 + 25 * MIN, endMs: null }],
        })
      ).waiting
    ).toBe(5 * MIN);
  });
});

describe('usualDurations', () => {
  it('takes the median of comparable runs and needs enough of them', () => {
    const runs = [1, 2, 3, 10].map((m) => ({
      createdAt: T0,
      machineReadyAt: T0 + m * MIN,
      agentStartAt: T0 + m * MIN + 2 * MIN,
    }));
    expect(usualDurations(runs, 'skill', 3)).toEqual({
      comparedBy: 'skill',
      machine: { usualMs: 2.5 * MIN, sampleSize: 4 },
      setup: { usualMs: 2 * MIN, sampleSize: 4 },
    });
    expect(usualDurations(runs.slice(0, 2), 'profile', 3)).toEqual({
      comparedBy: 'profile',
      machine: null,
      setup: null,
    });
  });

  it('ignores runs with missing or inverted timestamps', () => {
    const usual = usualDurations(
      [
        { createdAt: T0, machineReadyAt: null, agentStartAt: T0 },
        { createdAt: T0, machineReadyAt: T0 - MIN, agentStartAt: T0 - 2 * MIN },
        { createdAt: T0, machineReadyAt: T0 + MIN, agentStartAt: T0 + 3 * MIN },
      ],
      'skill',
      1
    );
    expect(usual.machine).toEqual({ usualMs: MIN, sampleSize: 1 });
    expect(usual.setup).toEqual({ usualMs: 2 * MIN, sampleSize: 1 });
  });

  it('median handles odd, even and empty input', () => {
    expect(median([3, 1, 2])).toBe(2);
    expect(median([4, 1, 3, 2])).toBe(2.5);
    expect(median([])).toBeNull();
  });
});

describe('slowedDown', () => {
  const base = {
    phases: computePhases(timeline()),
    usual: null,
    waiting: [{ startMs: T0 + 10 * MIN, endMs: T0 + 15 * MIN, reason: 'Use exponential backoff?' }],
    askTitles: [],
    checks: 'success' as const,
    peakMemoryBytes: 1_000_000_000,
    requestedMemoryMb: 4096,
    oomKills: 0,
  };

  it('lists a phase only against a usual duration, largest delay first, at most three', () => {
    const items = slowedDown(
      {
        ...base,
        usual: {
          comparedBy: 'skill',
          machine: { usualMs: 10_000, sampleSize: 5 },
          setup: { usualMs: MIN, sampleSize: 5 },
        },
        checks: 'failure',
        oomKills: 2,
      },
      limits
    );
    expect(items.map((item) => item.kind)).toEqual(['ci_failing', 'waiting', 'setup']);
    expect(items[2]).toMatchObject({ durationMs: 3 * MIN, usualMs: MIN, sampleSize: 5 });
  });

  it('does not call a phase slow without comparable runs, or within the usual range', () => {
    expect(slowedDown(base, limits).map((i) => i.kind)).toEqual(['waiting']);
    const within = slowedDown(
      {
        ...base,
        usual: {
          comparedBy: 'profile',
          machine: null,
          setup: { usualMs: 2.5 * MIN, sampleSize: 4 },
        },
      },
      limits
    );
    expect(within.map((i) => i.kind)).toEqual(['waiting']);
  });

  it('ignores short phases and names the longest question, truncated', () => {
    const long = 'Why? '.repeat(60);
    const items = slowedDown(
      {
        ...base,
        waiting: [
          { startMs: T0 + 10 * MIN, endMs: T0 + 11 * MIN, reason: 'short one' },
          { startMs: T0 + 12 * MIN, endMs: T0 + 16 * MIN, reason: long },
        ],
      },
      limits
    );
    expect(items[0]?.question?.length).toBe(160);
    expect(items[0]?.question?.endsWith('…')).toBe(true);
    const quiet = slowedDown(
      { ...base, phases: computePhases(timeline({ waiting: [] })), waiting: [] },
      limits
    );
    expect(quiet).toEqual([]);
  });

  it('flags memory near the request and out-of-memory kills after timed delays', () => {
    const items = slowedDown({ ...base, peakMemoryBytes: 4000 * 1024 * 1024, oomKills: 1 }, limits);
    expect(items.map((i) => i.kind)).toEqual(['waiting', 'oom', 'memory']);
  });
});
