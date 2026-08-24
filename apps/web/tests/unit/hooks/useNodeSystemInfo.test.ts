import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getNodeSystemInfo: vi.fn(),
}));

import { useNodeSystemInfo } from '../../../src/hooks/useNodeSystemInfo';
import { getNodeSystemInfo } from '../../../src/lib/api';
import { NODE_SYSTEM_INFO_POLL_MS } from '../../../src/lib/poll-intervals';

const mockGetNodeSystemInfo = vi.mocked(getNodeSystemInfo);

const INFO_A = { cpuCount: 4, memoryTotalMb: 8192, diskTotalGb: 80 };
const INFO_B = { cpuCount: 8, memoryTotalMb: 16384, diskTotalGb: 160 };

function setVisibility(state: DocumentVisibilityState) {
  Object.defineProperty(document, 'visibilityState', {
    configurable: true,
    get: () => state,
  });
  act(() => {
    document.dispatchEvent(new Event('visibilitychange'));
  });
}

const flush = () =>
  act(async () => {
    await Promise.resolve();
    await Promise.resolve();
  });

describe('useNodeSystemInfo', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mockGetNodeSystemInfo.mockReset();
    mockGetNodeSystemInfo.mockResolvedValue(INFO_A as never);
    setVisibility('visible');
  });

  afterEach(() => {
    vi.useRealTimers();
    setVisibility('visible');
  });

  it('loads system info for a running node', async () => {
    const { result } = renderHook(() => useNodeSystemInfo('node-1', 'running'));
    await flush();

    expect(mockGetNodeSystemInfo).toHaveBeenCalledWith('node-1');
    expect(result.current.systemInfo).toEqual(INFO_A);
  });

  it('does not fetch for a node that is not running', async () => {
    const { result } = renderHook(() => useNodeSystemInfo('node-1', 'stopped'));
    await flush();

    expect(mockGetNodeSystemInfo).not.toHaveBeenCalled();
    expect(result.current.systemInfo).toBeNull();
  });

  it('polls on the configured interval while visible', async () => {
    renderHook(() => useNodeSystemInfo('node-1', 'running'));
    await flush();
    mockGetNodeSystemInfo.mockClear();

    await act(async () => {
      vi.advanceTimersByTime(NODE_SYSTEM_INFO_POLL_MS);
      await Promise.resolve();
    });
    expect(mockGetNodeSystemInfo).toHaveBeenCalledTimes(1);
  });

  it('stops polling while the tab is hidden and catches up on return', async () => {
    renderHook(() => useNodeSystemInfo('node-1', 'running'));
    await flush();
    mockGetNodeSystemInfo.mockClear();

    setVisibility('hidden');
    await act(async () => {
      vi.advanceTimersByTime(NODE_SYSTEM_INFO_POLL_MS * 4);
      await Promise.resolve();
    });
    expect(mockGetNodeSystemInfo).not.toHaveBeenCalled();

    setVisibility('visible');
    await flush();
    expect(mockGetNodeSystemInfo).toHaveBeenCalledTimes(1);
  });

  it('keeps previous data visible during a background refresh (rule 48)', async () => {
    const { result } = renderHook(() => useNodeSystemInfo('node-1', 'running'));
    await flush();
    expect(result.current.systemInfo).toEqual(INFO_A);
    expect(result.current.loading).toBe(false);

    // A poll that has not resolved yet must not blank the data or re-raise the
    // first-load `loading` gate — only `isRefreshing` may flip.
    let resolvePoll!: (value: unknown) => void;
    mockGetNodeSystemInfo.mockImplementationOnce(
      () => new Promise((resolve) => (resolvePoll = resolve)) as never
    );
    await act(async () => {
      vi.advanceTimersByTime(NODE_SYSTEM_INFO_POLL_MS);
      await Promise.resolve();
    });

    expect(result.current.systemInfo).toEqual(INFO_A);
    expect(result.current.loading).toBe(false);
    expect(result.current.isRefreshing).toBe(true);

    await act(async () => {
      resolvePoll(INFO_B);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.systemInfo).toEqual(INFO_B);
    expect(result.current.isRefreshing).toBe(false);
  });

  it('fetches exactly once when the node becomes running long after mount', async () => {
    // Regression: the call site fetches when its precondition flips true, and
    // `useVisibilityAwarePoll` used to ALSO fire an elapsed-gated catch-up on
    // the same transition. VM boot takes far longer than one poll interval, so
    // every real "node became ready" produced two concurrent requests.
    const { rerender } = renderHook(
      ({ status }: { status: string }) => useNodeSystemInfo('node-1', status),
      { initialProps: { status: 'provisioning' } }
    );
    await flush();
    expect(mockGetNodeSystemInfo).not.toHaveBeenCalled();

    await act(async () => {
      vi.advanceTimersByTime(NODE_SYSTEM_INFO_POLL_MS * 6);
      await Promise.resolve();
    });

    rerender({ status: 'running' });
    await flush();

    expect(mockGetNodeSystemInfo).toHaveBeenCalledTimes(1);
  });

  it('discards an in-flight response after the node id changes', async () => {
    let resolveFirst!: (value: unknown) => void;
    mockGetNodeSystemInfo.mockImplementationOnce(
      () => new Promise((resolve) => (resolveFirst = resolve)) as never
    );

    const { result, rerender } = renderHook(
      ({ nodeId }: { nodeId: string }) => useNodeSystemInfo(nodeId, 'running'),
      { initialProps: { nodeId: 'node-1' } }
    );
    await flush();

    mockGetNodeSystemInfo.mockResolvedValueOnce(INFO_B as never);
    rerender({ nodeId: 'node-2' });
    await flush();
    expect(result.current.systemInfo).toEqual(INFO_B);

    // node-1's late response must not land under node-2's identity.
    await act(async () => {
      resolveFirst(INFO_A);
      await Promise.resolve();
      await Promise.resolve();
    });
    expect(result.current.systemInfo).toEqual(INFO_B);
  });

  it('clears state when the node stops running', async () => {
    const { result, rerender } = renderHook(
      ({ status }: { status: string }) => useNodeSystemInfo('node-1', status),
      { initialProps: { status: 'running' } }
    );
    await flush();
    expect(result.current.systemInfo).toEqual(INFO_A);

    rerender({ status: 'stopped' });
    await flush();
    expect(result.current.systemInfo).toBeNull();

    mockGetNodeSystemInfo.mockClear();
    await act(async () => {
      vi.advanceTimersByTime(NODE_SYSTEM_INFO_POLL_MS * 3);
      await Promise.resolve();
    });
    expect(mockGetNodeSystemInfo).not.toHaveBeenCalled();
  });
});
