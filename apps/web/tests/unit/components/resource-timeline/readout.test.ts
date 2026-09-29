import { describe, expect, it } from 'vitest';

import { formatToolName } from '../../../../src/components/chat/resource-timeline/format';
import {
  nearestBucket,
  readoutAtCursor,
  readoutForRange,
} from '../../../../src/components/chat/resource-timeline/readout';
import { buildSeries } from '../../../../src/components/chat/resource-timeline/series';
import { buildTimeAxis, toAxis } from '../../../../src/components/chat/resource-timeline/time-axis';
import type {
  ResourceAggregate,
  ResourceRun,
  ResourceToolSpan,
} from '../../../../src/components/chat/resource-timeline/types';

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const GB = 1024 ** 3;
const T0 = new Date(2026, 8, 28, 19, 0, 0).getTime();

function run(id: string, startedAt: number, endedAt: number): ResourceRun {
  return { id, nodeId: 'node-a', startedAt, endedAt, unsupportedReason: null, reservation: null };
}

function sample(end: number, cores: number): ResourceAggregate {
  return {
    start: end - 5 * SECOND,
    end,
    cpuMeanCores: cores,
    cpuMaxCores: cores,
    memoryMeanBytes: 3 * GB,
    memoryMaxBytes: 3 * GB,
    workingSetMeanBytes: 2 * GB,
    workingSetMaxBytes: 2 * GB,
    ioReadBytes: 0,
    ioWriteBytes: 5 * 1024 ** 2,
    oomKills: 0,
    toolCallStarts: 0,
    exact: true,
  };
}

const RUNS = [run('ws-1', T0, T0 + HOUR), run('ws-2', T0 + 10 * HOUR, T0 + 11 * HOUR)];
const SAMPLES = Array.from({ length: 720 }, (_, i) =>
  sample(T0 + (i + 1) * 5 * SECOND, i === 100 ? 3 : 0.5)
);
const BASH: ResourceToolSpan = {
  id: 'bash',
  kind: 'execute',
  name: 'Bash',
  startedAt: T0 + 8 * MINUTE,
  endedAt: T0 + 8 * MINUTE + 35 * SECOND,
  approximateEnd: false,
};

describe('nearestBucket', () => {
  it('picks the bucket whose centre is closest', () => {
    const series = { x: [10, 20, 30] } as Parameters<typeof nearestBucket>[0];
    expect(nearestBucket(series, 24)).toBe(1);
    expect(nearestBucket(series, 26)).toBe(2);
    expect(nearestBucket(series, -5)).toBe(0);
    expect(nearestBucket(series, 99)).toBe(2);
  });
});

describe('readoutAtCursor', () => {
  const axis = buildTimeAxis(RUNS, 'active');

  it('reads one 5-second measurement to the second when zoomed all the way in', () => {
    const view = { min: toAxis(axis, T0 + 8 * MINUTE), max: toAxis(axis, T0 + 9 * MINUTE) };
    const series = buildSeries(SAMPLES, axis, view.min, view.max, 400, 5 * SECOND);
    const at = toAxis(axis, T0 + 8 * MINUTE + 12 * SECOND);

    const readout = readoutAtCursor(at, series, axis, RUNS, [BASH], 5 * SECOND);

    expect(readout.time).not.toContain('avg');
    expect(readout.time).toMatch(/:\d{2}:\d{2}/);
    expect(readout.context).toBe('Run 1 of 2 · node-a');
    expect(readout.cpu).toBe('0.50 cores');
    expect(readout.memory).toBe('2.0 GB + 1.0 GB cache');
    expect(readout.tools).toBe('Bash running 35s');
  });

  it('labels a zoomed-out reading as an average and shows its peak', () => {
    const series = buildSeries(SAMPLES, axis, axis.min, axis.max, 30, 5 * SECOND);
    const at = toAxis(axis, T0 + 100 * 5 * SECOND);

    const readout = readoutAtCursor(at, series, axis, RUNS, [], 5 * SECOND);

    expect(readout.time).toContain('avg');
    expect(readout.cpu).toContain('peak 3.00 cores');
  });

  it('says the session was asleep, and for how long, between runs', () => {
    const series = buildSeries(SAMPLES, axis, axis.min, axis.max, 30, 5 * SECOND);
    const sleep = axis.spans[1];
    const middle = ((sleep?.axisStart ?? 0) + (sleep?.axisEnd ?? 0)) / 2;

    const readout = readoutAtCursor(middle, series, axis, RUNS, [], 5 * SECOND);

    expect(readout.context).toBe('Session asleep for 9h — no workspace was running');
    expect(readout.cpu).toBe('—');
  });
});

describe('readoutForRange', () => {
  it('describes the whole session without implying data is missing', () => {
    const axis = buildTimeAxis(RUNS, 'active');
    const readout = readoutForRange(axis.min, axis.max, axis, SAMPLES);

    expect(readout.time).toBe('Whole session');
    expect(readout.context).toBe('All 2h of active time');
    expect(readout.memory).toBe('peak 2.0 GB (3.0 GB w/ cache)');
  });

  it('does not call a truncated history the whole session', () => {
    const axis = buildTimeAxis(RUNS, 'active');
    const readout = readoutForRange(axis.min, axis.max, axis, SAMPLES, true);

    expect(readout.time).toBe('Everything shown');
    expect(readout.context).toBe('All 2h of shown active time');
  });
});

describe('formatToolName', () => {
  it('names MCP tools by tool, then server', () => {
    expect(formatToolName('mcp__sam-mcp__update_task_status')).toBe('update_task_status (sam-mcp)');
    // Agent-reported names can be arbitrarily long; the label is capped by characters, not bytes.
    const long = formatToolName(`mcp__sam-mcp__${'x'.repeat(200)}`);
    expect([...long]).toHaveLength(48);
    expect(long.endsWith('…')).toBe(true);
    expect(formatToolName('🔥'.repeat(60))).toBe(`${'🔥'.repeat(47)}…`);
    expect(formatToolName('Bash')).toBe('Bash');
    expect(formatToolName(null)).toBe('Tool call');
  });
});
