import type { RunReceipt } from '@simple-agent-manager/shared';
import { render, screen, within } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { ResourceTimelineIndex } from '../../../src/components/chat/resource-timeline/types';
import { RunReceiptView } from '../../../src/components/chat/run-receipt/RunReceiptView';

const MIN = 60_000;
const T0 = Date.parse('2026-11-15T10:00:00.000Z');

function receipt(overrides: Partial<RunReceipt> = {}): RunReceipt {
  return {
    projectId: 'p',
    taskId: 't',
    sessionId: 's',
    title: 'Add retry budget to snapshot uploads',
    status: 'completed',
    live: false,
    createdAt: new Date(T0).toISOString(),
    endedAt: new Date(T0 + 40 * MIN).toISOString(),
    totalMs: 40 * MIN,
    phases: [
      { key: 'machine', durationMs: 40_000 },
      { key: 'setup', durationMs: 190_000 },
      { key: 'agent', durationMs: 21.5 * MIN },
      { key: 'waiting', durationMs: 500_000 },
      { key: 'ci', durationMs: 9 * MIN },
    ],
    outcome: {
      pullRequest: {
        number: 2771,
        url: 'https://github.com/acme/app/pull/2771',
        title: 'Add retry budget',
        repository: 'acme/app',
        state: 'merged',
        mergedAt: new Date(T0 + 39 * MIN).toISOString(),
      },
      checks: 'success',
      ciFirstTry: 'not_recorded',
      terminalReason: null,
    },
    account: {
      agentType: 'claude-code',
      credentialSource: 'user',
      credentialScope: 'profile',
      accountName: 'Personal Max',
      isOwnSession: true,
    },
    resources: {
      measured: true,
      peakMemoryBytes: 3.1 * 1024 ** 3,
      requestedMemoryMb: 4096,
      peakCpuMillis: 1800,
      requestedCpuMillis: 2000,
      oomKills: 0,
    },
    toolCalls: {
      total: 186,
      byKind: [
        { kind: 'execute', count: 74 },
        { kind: 'read', count: 61 },
        { kind: 'edit', count: 39 },
        { kind: 'search', count: 12 },
      ],
      scanLimited: false,
    },
    tokens: { state: 'not_reported' },
    slowedDown: [
      {
        kind: 'waiting',
        durationMs: 500_000,
        usualMs: null,
        comparedBy: null,
        sampleSize: null,
        question: 'Use exponential backoff?',
        peakMemoryBytes: null,
        requestedMemoryMb: null,
        count: null,
      },
      {
        kind: 'setup',
        durationMs: 190_000,
        usualMs: 82_000,
        comparedBy: 'skill',
        sampleSize: 12,
        question: null,
        peakMemoryBytes: null,
        requestedMemoryMb: null,
        count: null,
      },
    ],
    unavailable: [],
    generatedAt: new Date(T0 + 41 * MIN).toISOString(),
    ...overrides,
  };
}

function index(points: Array<[number, number, number]>): ResourceTimelineIndex {
  return {
    runs: [],
    chunks: [
      {
        id: 'c1',
        runId: 'ws',
        startedAt: T0,
        endedAt: T0 + 40 * MIN,
        sampleCount: 100,
        memoryHighWaterBytes: null,
        overview: points.map(([minute, cores, tools]) => ({
          start: T0 + minute * MIN,
          end: T0 + (minute + 1) * MIN,
          cpuMeanCores: cores,
          cpuMaxCores: cores,
          memoryMeanBytes: null,
          memoryMaxBytes: null,
          workingSetMeanBytes: null,
          workingSetMaxBytes: null,
          ioReadBytes: null,
          ioWriteBytes: null,
          oomKills: 0,
          toolCallStarts: tools,
          exact: true,
        })),
      },
    ],
    sampleIntervalMs: 5000,
    uploadIntervalMs: 900_000,
    completeness: { kind: 'complete' },
    collection: 'collected',
  };
}

describe('RunReceiptView', () => {
  it('shows the outcome, phases, tiles and what slowed the run down', () => {
    render(<RunReceiptView receipt={receipt()} resourceIndex={undefined} />);
    expect(screen.getByText('Merged')).toBeInTheDocument();
    expect(screen.getByText('PR #2771 · CI passed · 40m')).toBeInTheDocument();
    expect(screen.getByRole('link', { name: '#2771 Add retry budget' })).toHaveAttribute(
      'href',
      'https://github.com/acme/app/pull/2771'
    );
    const bar = screen.getByTestId('receipt-phase-bar');
    expect(bar).toHaveAttribute(
      'aria-label',
      expect.stringContaining('Waiting on a person 8m 20s')
    );
    expect(bar.querySelectorAll('[data-phase]')).toHaveLength(5);
    expect(screen.getByText('Not reported')).toBeInTheDocument();
    expect(screen.getByText('Personal Max')).toBeInTheDocument();
    expect(screen.getByText('186')).toBeInTheDocument();
    expect(screen.getByText('74 shell · 61 read · 39 edit')).toBeInTheDocument();
    expect(screen.getByText('Waited 8m 20s on a person')).toBeInTheDocument();
    expect(screen.getByText('“Use exponential backoff?”')).toBeInTheDocument();
    expect(screen.getByText('Setup took 3m 10s')).toBeInTheDocument();
    expect(screen.getByText('2.3× this skill’s usual 82s (12 runs)')).toBeInTheDocument();
  });

  it('shows a teammate the kind of account, never its name', () => {
    render(
      <RunReceiptView
        receipt={receipt({
          account: {
            agentType: 'codex',
            credentialSource: 'project',
            credentialScope: 'project',
            accountName: null,
            isOwnSession: false,
          },
        })}
        resourceIndex={undefined}
      />
    );
    expect(screen.getByText('Project account')).toBeInTheDocument();
    expect(screen.queryByText('Personal Max')).not.toBeInTheDocument();
  });

  it('says what it could not measure instead of showing zeros', () => {
    render(
      <RunReceiptView
        receipt={receipt({
          live: true,
          status: 'in_progress',
          outcome: {
            pullRequest: null,
            checks: null,
            ciFirstTry: 'not_recorded',
            terminalReason: null,
          },
          phases: [
            { key: 'machine', durationMs: 60_000 },
            { key: 'setup', durationMs: null },
            { key: 'agent', durationMs: null },
            { key: 'waiting', durationMs: null },
            { key: 'ci', durationMs: null },
          ],
          resources: {
            measured: false,
            peakMemoryBytes: null,
            requestedMemoryMb: null,
            peakCpuMillis: null,
            requestedCpuMillis: null,
            oomKills: 0,
          },
          toolCalls: null,
          slowedDown: [],
          unavailable: ['toolCalls'],
        })}
        resourceIndex={undefined}
      />
    );
    expect(screen.getByText('Running')).toBeInTheDocument();
    expect(screen.getByText('40m so far')).toBeInTheDocument();
    expect(screen.getAllByText('not yet')).toHaveLength(4);
    expect(screen.getByText('No resource history for this run')).toBeInTheDocument();
    expect(screen.getByText('Not available for this chat')).toBeInTheDocument();
    expect(screen.getByText('No CPU history was recorded for this run.')).toBeInTheDocument();
    expect(screen.getByText('Nothing stood out against recent runs.')).toBeInTheDocument();
    expect(screen.getByText('Could not read tool calls just now.')).toBeInTheDocument();
    // Only the measured phase is drawn.
    expect(screen.getByTestId('receipt-phase-bar').querySelectorAll('[data-phase]')).toHaveLength(
      1
    );
  });

  it('draws the CPU line for the run window with a marker per minute that started tool calls', () => {
    const resourceIndex = index([
      [-5, 3.5, 4], // before the run: excluded
      [1, 0.2, 0],
      [2, 1.6, 3],
      [3, 0.4, 0],
      [4, 1.9, 1],
    ]);
    render(<RunReceiptView receipt={receipt()} resourceIndex={resourceIndex} />);
    const line = screen.getByTestId('receipt-cpu-line');
    expect(line.querySelectorAll('circle')).toHaveLength(2);
    expect(line).toHaveAttribute('aria-label', expect.stringContaining('peaking at 1.9 cores'));
    const figure = line.closest('figure');
    expect(figure).not.toBeNull();
    expect(
      within(figure as HTMLElement).getByText('Peak 1.9 cores of 2.0 requested')
    ).toBeInTheDocument();
  });
});
