import type { WebPushSubscriptionInput } from '@simple-agent-manager/shared';
import { useCallback, useEffect, useMemo, useState } from 'react';

import {
  getNotificationPreferences,
  getVapidPublicKey,
  listWebPushSubscriptions,
  subscribeWebPush,
  unsubscribeWebPush,
  updateNotificationPreference,
} from '../lib/api';

export interface PushSubscriptionDependencies {
  isSupported: () => boolean;
  getPermission: () => NotificationPermission | 'unsupported';
  requestPermission: () => Promise<NotificationPermission>;
  getSubscription: () => Promise<PushSubscription | null>;
  subscribe: (applicationServerKey: Uint8Array<ArrayBuffer>) => Promise<PushSubscription>;
  saveSubscription: typeof subscribeWebPush;
  removeSubscription: typeof unsubscribeWebPush;
  getPublicKey: typeof getVapidPublicKey;
  getPreferences: typeof getNotificationPreferences;
  listSubscriptions: typeof listWebPushSubscriptions;
  setPushPreference: (enabled: boolean) => Promise<void>;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

export function pushSubscriptionInput(subscription: PushSubscription): WebPushSubscriptionInput {
  const json = subscription.toJSON();
  const p256dh = json.keys?.p256dh;
  const auth = json.keys?.auth;
  if (!json.endpoint || !p256dh || !auth) {
    throw new Error('Browser returned an incomplete PushSubscription');
  }
  return {
    endpoint: json.endpoint,
    expirationTime: json.expirationTime ?? null,
    keys: { p256dh, auth },
  };
}

const browserDependencies: PushSubscriptionDependencies = {
  isSupported: () =>
    typeof window !== 'undefined' &&
    'Notification' in window &&
    'serviceWorker' in navigator &&
    'PushManager' in window,
  getPermission: () =>
    typeof Notification === 'undefined' ? 'unsupported' : Notification.permission,
  requestPermission: () => Notification.requestPermission(),
  getSubscription: async () => (await navigator.serviceWorker.ready).pushManager.getSubscription(),
  subscribe: async (applicationServerKey) =>
    (await navigator.serviceWorker.ready).pushManager.subscribe({
      userVisibleOnly: true,
      applicationServerKey,
    }),
  saveSubscription: subscribeWebPush,
  removeSubscription: unsubscribeWebPush,
  getPublicKey: getVapidPublicKey,
  getPreferences: getNotificationPreferences,
  listSubscriptions: listWebPushSubscriptions,
  setPushPreference: async (enabled) =>
    updateNotificationPreference({
      notificationType: '*',
      channel: 'web_push',
      enabled,
    }),
};

const NO_DEPENDENCY_OVERRIDES: Partial<PushSubscriptionDependencies> = {};

export function usePushSubscription(
  overrides: Partial<PushSubscriptionDependencies> = NO_DEPENDENCY_OVERRIDES
) {
  const dependencies = useMemo(() => ({ ...browserDependencies, ...overrides }), [overrides]);
  const supported = dependencies.isSupported();
  const [permission, setPermission] = useState<NotificationPermission | 'unsupported'>(() =>
    supported ? dependencies.getPermission() : 'unsupported'
  );
  const [subscription, setSubscription] = useState<PushSubscription | null>(null);
  const [pushPreferenceEnabled, setPushPreferenceEnabled] = useState(false);
  const [isLoading, setIsLoading] = useState(supported);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!supported) {
      setPermission('unsupported');
      setSubscription(null);
      setError(null);
      setIsLoading(false);
      return;
    }
    setPermission(dependencies.getPermission());
    try {
      const [currentSubscription, preferenceResponse] = await Promise.all([
        dependencies.getSubscription(),
        dependencies.getPreferences(),
      ]);
      const globalPreference = preferenceResponse.preferences.find(
        (preference) =>
          preference.notificationType === '*' &&
          preference.projectId === null &&
          preference.channel === 'web_push'
      );
      setPushPreferenceEnabled(globalPreference?.enabled ?? true);

      let verifiedSubscription = currentSubscription;
      if (currentSubscription) {
        try {
          const serverSubscriptions = await dependencies.listSubscriptions();
          const storedSubscription = serverSubscriptions.subscriptions.find(
            (stored) => stored.endpoint === currentSubscription.endpoint
          );
          if (!storedSubscription) {
            await currentSubscription.unsubscribe();
            verifiedSubscription = null;
          } else if (storedSubscription.disabledAt !== null) {
            // Delivery failures can disable a server subscription while the
            // browser still retains it. Report push as off; enable() can reuse
            // and re-register the browser endpoint to clear the disablement.
            verifiedSubscription = null;
          }
        } catch (cause) {
          // An origin-level subscription must never be trusted across account
          // changes. Fail closed when ownership cannot be established.
          await currentSubscription.unsubscribe().catch(() => false);
          verifiedSubscription = null;
          setSubscription(null);
          throw cause;
        }
      }
      setSubscription(verifiedSubscription);
      setError(null);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not read push subscription');
    } finally {
      setIsLoading(false);
    }
  }, [dependencies, supported]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!supported) return;
    const refreshWhenVisible = () => {
      if (document.visibilityState === 'visible') void refresh();
    };
    window.addEventListener('focus', refreshWhenVisible);
    document.addEventListener('visibilitychange', refreshWhenVisible);
    return () => {
      window.removeEventListener('focus', refreshWhenVisible);
      document.removeEventListener('visibilitychange', refreshWhenVisible);
    };
  }, [refresh, supported]);

  const enable = useCallback(async () => {
    if (!supported) return;
    setIsBusy(true);
    setError(null);
    try {
      const nextPermission =
        dependencies.getPermission() === 'granted'
          ? 'granted'
          : await dependencies.requestPermission();
      setPermission(nextPermission);
      if (nextPermission !== 'granted') return;
      const { publicKey } = await dependencies.getPublicKey();
      if (!publicKey) throw new Error('Web Push is not configured on this SAM deployment');
      const nextSubscription =
        (await dependencies.getSubscription()) ??
        (await dependencies.subscribe(base64UrlBytes(publicKey)));
      await dependencies.saveSubscription(pushSubscriptionInput(nextSubscription));
      await dependencies.setPushPreference(true);
      if ('serviceWorker' in navigator) {
        const registration = await navigator.serviceWorker.getRegistration();
        registration?.active?.postMessage({ type: 'push-subscription-enabled' });
      }
      setPushPreferenceEnabled(true);
      setSubscription(nextSubscription);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not enable push notifications');
    } finally {
      setIsBusy(false);
    }
  }, [dependencies, supported]);

  const disable = useCallback(async () => {
    setIsBusy(true);
    setError(null);
    try {
      const current = subscription ?? (await dependencies.getSubscription());
      if (current) {
        await dependencies.removeSubscription(current.endpoint);
        // Server removal is the delivery correctness boundary. Reflect it
        // immediately even if the browser unsubscribe or preference write
        // subsequently fails; enable() can safely reconcile either partial state.
        setSubscription(null);
        await current.unsubscribe();
      }
      await dependencies.setPushPreference(false);
      setPushPreferenceEnabled(false);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'Could not disable push notifications');
    } finally {
      setIsBusy(false);
    }
  }, [dependencies, subscription]);

  return {
    supported,
    permission,
    isSubscribed: subscription !== null && pushPreferenceEnabled,
    isLoading,
    isBusy,
    error,
    enable,
    disable,
    refresh,
  };
}
