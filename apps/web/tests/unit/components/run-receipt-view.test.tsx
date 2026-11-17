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
    expect(
      screen.getByRole('link', { name: /#2771 Add retry budget.*opens in a new tab/ })
    ).toHaveAttribute('href', 'https://github.com/acme/app/pull/2771');
    const bar = screen.getByTestId('receipt-phase-bar');
    expect(bar).toHaveAttribute('aria-hidden', 'true');
    expect(screen.getByText('Waiting on a person')).toBeInTheDocument();
    expect(screen.getByText('8m 20s')).toBeInTheDocument();
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

  it('says how the first push did, and nothing while it is pending or not recorded', () => {
    const outcome = receipt().outcome;
    const line = (ciFirstTry: RunReceipt['outcome']['ciFirstTry']) => {
      const { unmount } = render(
        <RunReceiptView
          receipt={receipt({ outcome: { ...outcome, ciFirstTry } })}
          resourceIndex={undefined}
        />
      );
      const text = screen.getByText(/^PR #2771 · /).textContent;
      unmount();
      return text;
    };
    expect(line('failed')).toBe('PR #2771 · CI passed · first push failed · 40m');
    expect(line('passed')).toBe('PR #2771 · CI passed · first push passed · 40m');
    expect(line('pending')).toBe('PR #2771 · CI passed · 40m');
    expect(line('not_recorded')).toBe('PR #2771 · CI passed · 40m');
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
    expect(screen.getByText('Could not be read just now')).toBeInTheDocument();
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
    expect(screen.getAllByTestId('receipt-cpu-marker')).toHaveLength(2);
    expect(line).toHaveAttribute('aria-label', expect.stringContaining('peaking at 1.9 cores'));
    const figure = line.closest('figure');
    expect(figure).not.toBeNull();
    expect(
      within(figure as HTMLElement).getByText('Peak 1.9 cores of 2.0 requested')
    ).toBeInTheDocument();
  });
});

describe('RunReceiptView — disclosures and loading', () => {
  it('reads a zero wait as 0s, not 0ms', () => {
    const base = receipt();
    render(
      <RunReceiptView
        receipt={{
          ...base,
          phases: base.phases.map((phase) =>
            phase.key === 'waiting' ? { ...phase, durationMs: 0 } : phase
          ),
        }}
        resourceIndex={undefined}
      />
    );
    expect(screen.getByText('0s')).toBeInTheDocument();
    expect(screen.queryByText('0ms')).not.toBeInTheDocument();
  });

  it('marks a waiting time that hit the question cap as a floor', () => {
    const base = receipt();
    render(
      <RunReceiptView
        receipt={{
          ...base,
          phases: base.phases.map((phase) =>
            phase.key === 'waiting' ? { ...phase, limited: true } : phase
          ),
        }}
        resourceIndex={undefined}
      />
    );
    expect(screen.getByText('8m 20s+')).toBeInTheDocument();
  });

  it('holds the CPU chart’s space while its history loads, and says so when it fails', () => {
    const { rerender } = render(
      <RunReceiptView receipt={receipt()} resourceIndex={undefined} cpuHistory="loading" />
    );
    expect(screen.getByTestId('receipt-cpu-loading')).toBeInTheDocument();
    expect(screen.queryByText('No CPU history was recorded for this run.')).not.toBeInTheDocument();
    rerender(<RunReceiptView receipt={receipt()} resourceIndex={undefined} cpuHistory="error" />);
    expect(screen.getByText("Couldn't load CPU history just now.")).toBeInTheDocument();
  });

  // Slice U: measured tokens per model; money only as a labelled estimate for API-key accounts.
  it('shows measured tokens per model and an API-key spend estimate', () => {
    render(
      <RunReceiptView
        receipt={receipt({
          tokens: {
            state: 'reported',
            source: 'harness',
            limited: false,
            total: { input: 320_000, output: 41_000, cacheRead: 2_100_000, cacheWrite: 0, reasoning: null },
            spend: { state: 'estimate', usd: 4.12, unpricedModels: [] },
            models: [
              {
                model: 'claude-opus-5-5',
                input: 300_000,
                output: 40_000,
                cacheRead: 2_100_000,
                cacheWrite: 0,
                reasoning: null,
                estimatedSpendUsd: 4.0,
              },
              {
                model: null,
                input: 20_000,
                output: 1_000,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: 500,
                estimatedSpendUsd: null,
              },
            ],
          },
        })}
        resourceIndex={undefined}
      />
    );
    expect(screen.getByText('2.5M')).toBeInTheDocument();
    expect(screen.getByText('Incl. 2.1M cache · Reported by the agent')).toBeInTheDocument();
    const models = screen.getByTestId('receipt-token-models');
    const rows = within(models).getAllByRole('listitem');
    expect(rows[0]).toHaveTextContent('claude-opus-5-5300K in· 40K out· 2.1M cache~$4.00');
    expect(rows[1]).toHaveTextContent('Model not reported20K in· 1K out· 500 reasoningno price');
    expect(screen.getByTestId('receipt-token-spend')).toHaveTextContent(
      '~$4.12 estimated at SAM’s model prices'
    );
    expect(screen.queryByText('Not reported')).not.toBeInTheDocument();
  });

  it('shows tokens without money for a subscription account', () => {
    render(
      <RunReceiptView
        receipt={receipt({
          tokens: {
            state: 'reported',
            source: 'ai_proxy',
            limited: true,
            total: { input: 900, output: 100, cacheRead: 0, cacheWrite: 0, reasoning: null },
            spend: { state: 'not_applicable' },
            models: [
              {
                model: 'gpt-5.5',
                input: 900,
                output: 100,
                cacheRead: 0,
                cacheWrite: 0,
                reasoning: null,
                estimatedSpendUsd: null,
              },
            ],
          },
        })}
        resourceIndex={undefined}
      />
    );
    expect(screen.getByText('1K+')).toBeInTheDocument();
    expect(screen.getByText('Measured by SAM’s AI proxy')).toBeInTheDocument();
    expect(screen.queryByText(/estimated/)).not.toBeInTheDocument();
    expect(screen.queryByTestId('receipt-token-spend')).not.toBeInTheDocument();
  });

  it('says a failed token read could not be read, not that the agent reported nothing', () => {
    render(
      <RunReceiptView
        receipt={receipt({ tokens: { state: 'not_reported' }, unavailable: ['tokens'] })}
        resourceIndex={undefined}
      />
    );
    expect(screen.queryByText('This agent did not report token counts')).not.toBeInTheDocument();
    expect(screen.getAllByText('Could not be read just now').length).toBeGreaterThan(0);
    expect(screen.getByText('Could not read token usage just now.')).toBeInTheDocument();
  });

  it('says tokens are not reported yet while the run is live', () => {
    render(<RunReceiptView receipt={receipt({ live: true, status: 'in_progress' })} resourceIndex={undefined} />);
    expect(screen.getByText('Not reported yet')).toBeInTheDocument();
  });

  it('shows no money for another member’s personal key, and a floor when a model is unpriced', () => {
    const tokens = (spend: RunReceipt['tokens'] extends infer T ? T : never) => spend;
    const base = {
      state: 'reported' as const,
      source: 'harness' as const,
      limited: false,
      total: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, reasoning: null },
      models: [
        { model: 'a', input: 5, output: 2, cacheRead: 0, cacheWrite: 0, reasoning: null, estimatedSpendUsd: 0.004 },
        { model: 'b', input: 5, output: 3, cacheRead: 0, cacheWrite: 0, reasoning: null, estimatedSpendUsd: null },
      ],
    };
    const { unmount } = render(
      <RunReceiptView
        receipt={receipt({ tokens: tokens({ ...base, spend: { state: 'private' } }) })}
        resourceIndex={undefined}
      />
    );
    expect(screen.queryByTestId('receipt-token-spend')).not.toBeInTheDocument();
    expect(screen.queryByText(/\$/)).not.toBeInTheDocument();
    unmount();
    render(
      <RunReceiptView
        receipt={receipt({
          tokens: tokens({ ...base, spend: { state: 'estimate', usd: 0.004, unpricedModels: ['b'] } }),
        })}
        resourceIndex={undefined}
      />
    );
    expect(screen.getByTestId('receipt-token-spend')).toHaveTextContent(
      'At least ~<$0.01 estimated at SAM’s model prices'
    );
    expect(screen.getByText('no price')).toBeInTheDocument();
  });
});
