import { act, renderHook } from '@testing-library/react';
import { afterEach, expect, it, vi } from 'vitest';

import { CHAT_FALLBACK_POLL_MS } from '../../../src/components/project-message-view/types';
import { useFallbackSessionPoll } from '../../../src/components/project-message-view/useFallbackSessionPoll';

const mocks = vi.hoisted(() => ({ fetch: vi.fn() }));
vi.mock('../../../src/lib/message-paging', () => ({ fetchNewestPage: mocks.fetch }));
vi.mock('../../../src/hooks/useVisibilityAwarePoll', () => ({ useDocumentVisible: () => true }));
afterEach(() => vi.useRealTimers());
it('refreshes a sleeping chat when only the provider wait changes or clears', async () => {
  vi.useFakeTimers();
  const setTaskEmbed = vi.fn();
  const session = {
    id: 'session',
    status: 'sleeping',
    task: { id: 'task', status: 'queued', providerLimitReason: 'Waiting until reset' },
  };
  let reason: string | null = 'Waiting until reset';
  let version = 'window-1';
  mocks.fetch.mockImplementation(async () => ({
    session: {
      ...session,
      task: { ...session.task, providerLimitReason: reason, providerLimitVersion: version },
    },
    messages: [],
    state: null,
  }));
  const input = {
    projectId: 'project',
    sessionId: 'session',
    session,
    connectionState: 'disconnected',
    mergeRecentWindow: vi.fn().mockResolvedValue(undefined),
    sleepingWakePendingRef: { current: false },
    setSession: vi.fn(),
    setTaskEmbed,
    hydrateState: vi.fn(),
    hydratePlan: vi.fn(),
    hydrateWakeProgress: vi.fn(),
  } as unknown as Parameters<typeof useFallbackSessionPoll>[0];
  renderHook(() => useFallbackSessionPoll(input));
  await act(() => vi.advanceTimersByTimeAsync(CHAT_FALLBACK_POLL_MS));
  reason = 'Blocked: wait budget exhausted';
  await act(() => vi.advanceTimersByTimeAsync(CHAT_FALLBACK_POLL_MS));
  expect(setTaskEmbed).toHaveBeenLastCalledWith(
    expect.objectContaining({ providerLimitReason: reason, providerLimitVersion: version })
  );
  version = 'window-2';
  await act(() => vi.advanceTimersByTimeAsync(CHAT_FALLBACK_POLL_MS));
  expect(setTaskEmbed).toHaveBeenLastCalledWith(
    expect.objectContaining({ providerLimitVersion: version, providerLimitReason: reason })
  );
  reason = null;
  await act(() => vi.advanceTimersByTimeAsync(CHAT_FALLBACK_POLL_MS));
  expect(setTaskEmbed).toHaveBeenLastCalledWith(
    expect.objectContaining({ providerLimitReason: null })
  );
  expect(setTaskEmbed).toHaveBeenCalledTimes(4);
});
