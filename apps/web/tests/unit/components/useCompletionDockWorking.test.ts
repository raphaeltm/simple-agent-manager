import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { AgentActivityState } from '../../../src/components/project-message-view/types';
import {
  COMPLETION_DOCK_IDLE_STABILIZE_MS,
  useCompletionDockWorking,
} from '../../../src/components/project-message-view/useCompletionDockWorking';

describe('useCompletionDockWorking', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.clearAllTimers();
    vi.useRealTimers();
  });

  it('promotes idle to working immediately', () => {
    const { result, rerender } = renderHook(
      ({ activity }: { activity: AgentActivityState }) => useCompletionDockWorking(activity),
      { initialProps: { activity: 'idle' } }
    );

    expect(result.current).toBe(false);

    rerender({ activity: 'prompting' });

    expect(result.current).toBe(true);
  });

  it('delays working to idle transitions', async () => {
    const { result, rerender } = renderHook(
      ({ activity }: { activity: AgentActivityState }) => useCompletionDockWorking(activity),
      { initialProps: { activity: 'responding' } }
    );

    expect(result.current).toBe(true);

    rerender({ activity: 'idle' });

    expect(result.current).toBe(true);
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPLETION_DOCK_IDLE_STABILIZE_MS - 1);
    });
    expect(result.current).toBe(true);

    await act(async () => {
      await vi.advanceTimersByTimeAsync(1);
    });
    expect(result.current).toBe(false);
  });

  it('swallows an idle transition that reverses within the stabilization window', async () => {
    const { result, rerender } = renderHook(
      ({ activity }: { activity: AgentActivityState }) => useCompletionDockWorking(activity),
      { initialProps: { activity: 'prompting' } }
    );

    rerender({ activity: 'idle' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPLETION_DOCK_IDLE_STABILIZE_MS / 2);
    });
    expect(result.current).toBe(true);

    rerender({ activity: 'responding' });
    await act(async () => {
      await vi.advanceTimersByTimeAsync(COMPLETION_DOCK_IDLE_STABILIZE_MS);
    });

    expect(result.current).toBe(true);
  });
});
