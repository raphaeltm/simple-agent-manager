import { act,renderHook } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  getChatSessionState: vi.fn(),
}));

vi.mock('../../src/lib/api', () => ({
  getChatSessionState: mocks.getChatSessionState,
}));

import { useActivityVerifyTimer } from '../../src/components/project-message-view/useActivityVerifyTimer';

describe('useActivityVerifyTimer', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    mocks.getChatSessionState.mockReset();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('calls onVerifiedStale before onVerifiedIdle when server reports idle', async () => {
    const onVerifiedIdle = vi.fn();
    const onVerifiedStale = vi.fn();

    mocks.getChatSessionState.mockResolvedValue({
      state: { activity: 'idle' },
    });

    const { result } = renderHook(() =>
      useActivityVerifyTimer({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        delayMs: 5000,
        logMessage: 'test',
        onVerifiedIdle,
        onVerifiedStale,
      })
    );

    act(() => {
      result.current.startVerifyDecayTimer();
    });

    await act(async () => {
      vi.advanceTimersByTime(5000);
      await vi.runAllTimersAsync();
    });

    expect(onVerifiedStale).toHaveBeenCalledTimes(1);
    expect(onVerifiedIdle).toHaveBeenCalledTimes(1);
    // The stale notice must be armed BEFORE the activity state clears, so the
    // UI can never render an idle frame without the notice.
    expect(onVerifiedStale.mock.invocationCallOrder[0]).toBeLessThan(
      onVerifiedIdle.mock.invocationCallOrder[0]
    );
  });

  it('does not call onVerifiedStale when activity is working', async () => {
    const onVerifiedIdle = vi.fn();
    const onVerifiedStale = vi.fn();

    mocks.getChatSessionState.mockResolvedValue({
      state: { activity: 'prompting' },
    });

    const { result } = renderHook(() =>
      useActivityVerifyTimer({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        delayMs: 5000,
        logMessage: 'test',
        onVerifiedIdle,
        onVerifiedStale,
      })
    );

    act(() => {
      result.current.startVerifyDecayTimer();
    });

    await act(async () => {
      vi.advanceTimersByTime(5100);
      await Promise.resolve();
    });

    // Still working — stop to prevent re-arm loop
    act(() => {
      result.current.stopVerifyDecayTimer();
    });

    expect(onVerifiedStale).not.toHaveBeenCalled();
    expect(onVerifiedIdle).not.toHaveBeenCalled();
  });

  it('does not call onVerifiedStale after stop', async () => {
    const onVerifiedStale = vi.fn();

    mocks.getChatSessionState.mockResolvedValue({
      state: { activity: 'idle' },
    });

    const { result } = renderHook(() =>
      useActivityVerifyTimer({
        projectId: 'proj-1',
        sessionId: 'sess-1',
        delayMs: 5000,
        logMessage: 'test',
        onVerifiedIdle: vi.fn(),
        onVerifiedStale,
      })
    );

    act(() => {
      result.current.startVerifyDecayTimer();
    });

    act(() => {
      result.current.stopVerifyDecayTimer();
    });

    await act(async () => {
      vi.advanceTimersByTime(10000);
      await vi.runAllTimersAsync();
    });

    expect(onVerifiedStale).not.toHaveBeenCalled();
  });
});
