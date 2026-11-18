import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { act, renderHook, waitFor } from '@testing-library/react';
import type { ReactNode } from 'react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { useProfilePicker } from '../../../src/hooks/useProfilePicker';

const mocks = vi.hoisted(() => ({
  getProfilePickerState: vi.fn(),
  updateProfilePicker: vi.fn(),
}));

vi.mock('../../../src/lib/api', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/lib/api')>()),
  getProfilePickerState: mocks.getProfilePickerState,
  updateProfilePicker: mocks.updateProfilePicker,
}));

function wrapper() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false, staleTime: 60_000 }, mutations: { retry: false } },
  });
  function Wrapper({ children }: { children: ReactNode }) {
    return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
  }
  return Wrapper;
}

describe('useProfilePicker', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.getProfilePickerState.mockResolvedValue({
      usage: [],
      hiddenProfileIds: ['a'],
      usageWindowDays: 30,
    });
  });

  it('reports loading, then ready', async () => {
    const { result } = renderHook(() => useProfilePicker('p1', 'user-1'), { wrapper: wrapper() });
    expect(result.current.picker).toEqual({ status: 'loading' });
    await waitFor(() => expect(result.current.picker.status).toBe('ready'));
    expect(result.current.state?.hiddenProfileIds).toEqual(['a']);
  });

  it('reports unavailable when the request fails, so callers can fall back', async () => {
    mocks.getProfilePickerState.mockRejectedValueOnce(new Error('down'));
    const { result } = renderHook(() => useProfilePicker('p1', 'user-1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.picker).toEqual({ status: 'unavailable' }));
  });

  it('hides optimistically and keeps the server answer', async () => {
    let release: (value: { hiddenProfileIds: string[] }) => void = () => undefined;
    mocks.updateProfilePicker.mockReturnValueOnce(
      new Promise((resolve) => {
        release = resolve;
      })
    );
    const { result } = renderHook(() => useProfilePicker('p1', 'user-1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.picker.status).toBe('ready'));

    let pending: Promise<void> = Promise.resolve();
    act(() => {
      pending = result.current.setHidden({ hide: ['b'] });
    });
    // Midpoint: the request is in flight, the list already reflects the change.
    await waitFor(() => expect(result.current.state?.hiddenProfileIds).toEqual(['a', 'b']));

    await act(async () => {
      release({ hiddenProfileIds: ['a', 'b'] });
      await pending;
    });
    expect(mocks.updateProfilePicker).toHaveBeenCalledWith('p1', { hide: ['b'] });
    expect(result.current.state?.hiddenProfileIds).toEqual(['a', 'b']);
  });

  it('rolls back an optimistic change the server rejects and surfaces the error', async () => {
    mocks.updateProfilePicker.mockRejectedValueOnce(new Error('Not available in this project'));
    const { result } = renderHook(() => useProfilePicker('p1', 'user-1'), { wrapper: wrapper() });
    await waitFor(() => expect(result.current.picker.status).toBe('ready'));

    await act(async () => {
      await result.current.setHidden({ unhide: ['a'] }).catch(() => undefined);
    });

    await waitFor(() => expect(result.current.updateError).toBe('Not available in this project'));
    expect(result.current.state?.hiddenProfileIds).toEqual(['a']);
  });
});
