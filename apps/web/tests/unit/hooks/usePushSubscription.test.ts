import { act, renderHook, waitFor } from '@testing-library/react';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { PushSubscriptionDependencies } from '../../../src/hooks/usePushSubscription';
import { usePushSubscription } from '../../../src/hooks/usePushSubscription';

function fakeSubscription(): PushSubscription {
  return {
    endpoint: 'https://push.example.test/subscription',
    expirationTime: null,
    options: { userVisibleOnly: true, applicationServerKey: null },
    getKey: vi.fn(),
    unsubscribe: vi.fn().mockResolvedValue(true),
    toJSON: () => ({
      endpoint: 'https://push.example.test/subscription',
      expirationTime: null,
      keys: { p256dh: 'receiver-key', auth: 'auth-key' },
    }),
  } as unknown as PushSubscription;
}

describe('usePushSubscription', () => {
  let subscription: PushSubscription;
  let dependencies: PushSubscriptionDependencies;

  beforeEach(() => {
    subscription = fakeSubscription();
    dependencies = {
      isSupported: () => true,
      getPermission: () => 'default',
      requestPermission: vi.fn().mockResolvedValue('granted'),
      getSubscription: vi.fn().mockResolvedValue(null),
      subscribe: vi.fn().mockResolvedValue(subscription),
      saveSubscription: vi.fn().mockResolvedValue({}),
      removeSubscription: vi.fn().mockResolvedValue(undefined),
      getPublicKey: vi.fn().mockResolvedValue({ publicKey: 'AQID' }),
      getPreferences: vi.fn().mockResolvedValue({ preferences: [] }),
      listSubscriptions: vi.fn().mockResolvedValue({ subscriptions: [] }),
      setPushPreference: vi.fn().mockResolvedValue(undefined),
    } as unknown as PushSubscriptionDependencies;
  });

  it('does not request permission during initial status discovery', async () => {
    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    expect(dependencies.requestPermission).not.toHaveBeenCalled();
  });

  it('subscribes and persists only after an explicit enable action', async () => {
    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.enable());

    expect(dependencies.requestPermission).toHaveBeenCalledOnce();
    expect(dependencies.subscribe).toHaveBeenCalledWith(Uint8Array.of(1, 2, 3));
    expect(dependencies.saveSubscription).toHaveBeenCalledWith({
      endpoint: subscription.endpoint,
      expirationTime: null,
      keys: { p256dh: 'receiver-key', auth: 'auth-key' },
    });
    expect(dependencies.setPushPreference).toHaveBeenCalledWith(true);
    expect(result.current.isSubscribed).toBe(true);
  });

  it('keeps a verified subscription only while the global preference is enabled', async () => {
    vi.mocked(dependencies.getSubscription).mockResolvedValue(subscription);
    vi.mocked(dependencies.listSubscriptions).mockResolvedValue({
      subscriptions: [
        {
          endpoint: subscription.endpoint,
          expirationTime: null,
          userAgent: null,
          disabledAt: null,
          failureCount: 0,
          lastSuccessAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    vi.mocked(dependencies.getPreferences).mockResolvedValue({
      preferences: [
        { notificationType: '*', projectId: null, channel: 'web_push', enabled: false },
      ],
    });

    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isSubscribed).toBe(false);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('invalidates a browser endpoint not owned by the authenticated user', async () => {
    vi.mocked(dependencies.getSubscription).mockResolvedValue(subscription);

    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(result.current.isSubscribed).toBe(false);
  });

  it('reports a server-disabled endpoint as off without discarding the reusable browser endpoint', async () => {
    vi.mocked(dependencies.getSubscription).mockResolvedValue(subscription);
    vi.mocked(dependencies.listSubscriptions).mockResolvedValue({
      subscriptions: [
        {
          endpoint: subscription.endpoint,
          userAgent: null,
          disabledAt: new Date().toISOString(),
          failureCount: 5,
          lastSuccessAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });

    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    expect(result.current.isSubscribed).toBe(false);
    expect(subscription.unsubscribe).not.toHaveBeenCalled();
  });

  it('fails closed and clears a previously verified subscription when ownership refresh fails', async () => {
    vi.mocked(dependencies.getSubscription).mockResolvedValue(subscription);
    vi.mocked(dependencies.listSubscriptions).mockResolvedValue({
      subscriptions: [
        {
          endpoint: subscription.endpoint,
          userAgent: null,
          disabledAt: null,
          failureCount: 0,
          lastSuccessAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));
    vi.mocked(dependencies.listSubscriptions).mockRejectedValueOnce(
      new Error('ownership unavailable')
    );

    await act(() => result.current.refresh());

    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toBe('ownership unavailable');
  });

  it('clears a transient refresh error after the next successful reconciliation', async () => {
    vi.mocked(dependencies.getPreferences)
      .mockRejectedValueOnce(new Error('preferences unavailable'))
      .mockResolvedValue({ preferences: [] });
    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.error).toBe('preferences unavailable'));

    await act(() => result.current.refresh());

    expect(result.current.error).toBeNull();
  });

  it('disables both the current endpoint and the user-global preference', async () => {
    vi.mocked(dependencies.getSubscription).mockResolvedValue(subscription);
    vi.mocked(dependencies.listSubscriptions).mockResolvedValue({
      subscriptions: [
        {
          endpoint: subscription.endpoint,
          expirationTime: null,
          userAgent: null,
          disabledAt: null,
          failureCount: 0,
          lastSuccessAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.disable());

    expect(dependencies.removeSubscription).toHaveBeenCalledWith(subscription.endpoint);
    expect(subscription.unsubscribe).toHaveBeenCalledOnce();
    expect(dependencies.setPushPreference).toHaveBeenCalledWith(false);
    expect(result.current.isSubscribed).toBe(false);
  });

  it('stays off after server removal when the preference update fails', async () => {
    vi.mocked(dependencies.getSubscription).mockResolvedValue(subscription);
    vi.mocked(dependencies.listSubscriptions).mockResolvedValue({
      subscriptions: [
        {
          endpoint: subscription.endpoint,
          userAgent: null,
          disabledAt: null,
          failureCount: 0,
          lastSuccessAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        },
      ],
    });
    vi.mocked(dependencies.setPushPreference).mockRejectedValueOnce(
      new Error('preference update failed')
    );
    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isSubscribed).toBe(true));

    await act(() => result.current.disable());

    expect(dependencies.removeSubscription).toHaveBeenCalledWith(subscription.endpoint);
    expect(result.current.isSubscribed).toBe(false);
    expect(result.current.error).toBe('preference update failed');
  });

  it('surfaces denied permission without attempting a subscription', async () => {
    vi.mocked(dependencies.requestPermission).mockResolvedValue('denied');
    const { result } = renderHook(() => usePushSubscription(dependencies));
    await waitFor(() => expect(result.current.isLoading).toBe(false));

    await act(() => result.current.enable());

    expect(result.current.permission).toBe('denied');
    expect(dependencies.subscribe).not.toHaveBeenCalled();
  });
});
