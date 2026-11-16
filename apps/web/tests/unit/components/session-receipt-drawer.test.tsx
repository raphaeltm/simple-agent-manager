/**
 * The Receipt panel's read states: a spinner only before the first receipt, a refetch that keeps
 * the receipt on screen (`apps/web/.claude/rules/48`), and an error with a working retry.
 */
import type { RunReceipt } from '@simple-agent-manager/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/hooks/useQueryScope', () => ({ useQueryScope: () => 'viewer-1' }));

const api = vi.hoisted(() => ({
  getRunReceipt: vi.fn(),
  getSessionResourceTimeline: vi.fn(),
}));
vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getRunReceipt: api.getRunReceipt,
  getSessionResourceTimeline: api.getSessionResourceTimeline,
}));

import { SessionReceiptDrawer } from '../../../src/components/chat/run-receipt/SessionReceiptDrawer';
import { runReceiptQueryKeys } from '../../../src/lib/query-options';

function receipt(title = 'First run'): RunReceipt {
  return {
    projectId: 'p',
    taskId: 't',
    sessionId: 's',
    title,
    status: 'completed',
    live: false,
    createdAt: '2026-11-15T10:00:00.000Z',
    endedAt: '2026-11-15T10:10:00.000Z',
    totalMs: 600_000,
    phases: [
      { key: 'machine', durationMs: 60_000 },
      { key: 'setup', durationMs: 60_000 },
      { key: 'agent', durationMs: 480_000 },
      { key: 'waiting', durationMs: 0 },
      { key: 'ci', durationMs: null },
    ],
    outcome: { pullRequest: null, checks: null, ciFirstTry: 'not_recorded', terminalReason: null },
    account: null,
    resources: {
      measured: false,
      peakMemoryBytes: null,
      requestedMemoryMb: null,
      peakCpuMillis: null,
      requestedCpuMillis: null,
      oomKills: 0,
    },
    toolCalls: { total: 7, byKind: [{ kind: 'read', count: 7 }], scanLimited: false },
    tokens: { state: 'not_reported' },
    slowedDown: [],
    unavailable: [],
    generatedAt: '2026-11-15T10:11:00.000Z',
  };
}

function renderDrawer() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } });
  render(
    <QueryClientProvider client={client}>
      <SessionReceiptDrawer projectId="p" sessionId="s" taskId="t" onClose={() => undefined} />
    </QueryClientProvider>
  );
  return client;
}

afterEach(() => vi.clearAllMocks());

describe('SessionReceiptDrawer', () => {
  it('shows a spinner before the first receipt, then keeps the receipt through a refetch', async () => {
    api.getSessionResourceTimeline.mockResolvedValue({
      sessionId: 's',
      runs: [],
      chunks: [],
      totalChunkCount: 0,
      omittedChunkCount: 0,
      maxChunks: 1000,
      collection: 'unsupported',
      runtime: 'cf-container',
    });
    let release: (value: RunReceipt) => void = () => undefined;
    api.getRunReceipt.mockResolvedValueOnce(receipt()).mockImplementationOnce(
      () =>
        new Promise<RunReceipt>((resolve) => {
          release = resolve;
        })
    );
    const client = renderDrawer();
    expect(screen.getByTestId('run-receipt-loading')).toBeInTheDocument();
    await screen.findByTestId('run-receipt');
    expect(api.getRunReceipt).toHaveBeenCalledWith('p', 't');

    // A background refetch is in flight: the receipt stays mounted, no spinner returns.
    act(() => {
      void client.invalidateQueries({ queryKey: runReceiptQueryKeys.all('viewer-1') });
    });
    await waitFor(() => expect(api.getRunReceipt).toHaveBeenCalledTimes(2));
    expect(screen.getByTestId('run-receipt')).toBeInTheDocument();
    expect(screen.queryByTestId('run-receipt-loading')).not.toBeInTheDocument();
    await act(async () => release(receipt('Second run')));
  });

  it('shows an alert with a retry that loads the receipt', async () => {
    api.getSessionResourceTimeline.mockResolvedValue({
      sessionId: 's',
      runs: [],
      chunks: [],
      totalChunkCount: 0,
      omittedChunkCount: 0,
      maxChunks: 1000,
      collection: 'pending',
      runtime: 'vm',
    });
    api.getRunReceipt.mockRejectedValueOnce(new Error('boom')).mockResolvedValueOnce(receipt());
    renderDrawer();
    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent("Couldn't load the receipt");
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    await screen.findByTestId('run-receipt');
    expect(api.getRunReceipt).toHaveBeenCalledTimes(2);
  });
});
