/// <reference lib="webworker" />

// Cast self to ServiceWorkerGlobalScope for proper typing.
// The default WebWorker lib types self as WorkerGlobalScope which lacks
// service worker APIs (skipWaiting, clients, install/activate/fetch events).
const sw = self as unknown as ServiceWorkerGlobalScope;

const SHELL_CACHE = 'sam-shell-v3';
const RUNTIME_CACHE = 'sam-runtime-v3';
const OFFLINE_URL = '/offline.html';
const APP_SHELL: string[] = [
  '/',
  '/index.html',
  '/manifest.webmanifest',
  '/favicon.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/apple-touch-icon.png',
  OFFLINE_URL,
];
let pushSubscriptionRefreshSuppressed = false;

sw.addEventListener('install', (event: ExtendableEvent) => {
  event.waitUntil(caches.open(SHELL_CACHE).then((cache) => cache.addAll(APP_SHELL)));
  sw.skipWaiting();
});

sw.addEventListener('activate', (event: ExtendableEvent) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) =>
        Promise.all(
          keys
            .filter((key) => key !== SHELL_CACHE && key !== RUNTIME_CACHE)
            .map((key) => caches.delete(key))
        )
      )
  );
  sw.clients.claim();
});

sw.addEventListener('fetch', (event: FetchEvent) => {
  const request = event.request;

  if (request.method !== 'GET') {
    return;
  }

  const url = new URL(request.url);
  if (url.origin !== sw.location.origin) {
    return;
  }

  if (request.mode === 'navigate') {
    event.respondWith(networkFirstNavigation(request));
    return;
  }

  if (['script', 'style', 'font', 'image'].includes(request.destination)) {
    event.respondWith(staleWhileRevalidate(request));
  }
});

interface DeclarativePushPayload {
  web_push: 8030;
  notification: {
    title: string;
    body?: string;
    navigate: string;
    app_badge?: string;
    actions?: Array<{ action: string; title: string; navigate: string }>;
  };
}

sw.addEventListener('push', (event: PushEvent) => {
  const data = event.data;
  if (!data) return;
  event.waitUntil(
    (async () => {
      const payload = data.json() as DeclarativePushPayload;
      if (payload.web_push !== 8030 || !payload.notification?.title) return;
      const navigate = safeAppUrl(payload.notification.navigate);
      const actionNavigate = Object.fromEntries(
        (payload.notification.actions ?? []).map((action) => [
          action.action,
          safeAppUrl(action.navigate),
        ])
      );
      const options = {
        body: payload.notification.body,
        icon: '/icons/icon-192.png',
        badge: '/icons/icon-192.png',
        data: { navigate, actionNavigate },
        actions: payload.notification.actions?.map((action) => ({
          action: action.action,
          title: action.title,
        })),
      } as NotificationOptions & { actions?: Array<{ action: string; title: string }> };
      await sw.registration.showNotification(payload.notification.title, options);
    })()
  );
});

sw.addEventListener('notificationclick', (event: NotificationEvent) => {
  event.notification.close();
  event.waitUntil(
    (async () => {
      const payload = event.notification.data as
        | {
            navigate?: unknown;
            actionNavigate?: Record<string, unknown>;
          }
        | undefined;
      const actionTarget =
        event.action && typeof payload?.actionNavigate?.[event.action] === 'string'
          ? payload.actionNavigate[event.action]
          : payload?.navigate;
      const target = safeAppUrl(typeof actionTarget === 'string' ? actionTarget : '/');
      const windows = await sw.clients.matchAll({ type: 'window', includeUncontrolled: true });
      const exact = windows.find((client) => client.url === target);
      if (exact && 'focus' in exact) {
        await (exact as WindowClient).focus();
        return;
      }
      const existing = windows.find((client) => new URL(client.url).origin === sw.location.origin);
      if (existing && 'navigate' in existing && 'focus' in existing) {
        await (existing as WindowClient).navigate(target);
        await (existing as WindowClient).focus();
        return;
      }
      await sw.clients.openWindow(target);
    })()
  );
});

sw.addEventListener('pushsubscriptionchange', (event: PushSubscriptionChangeEvent) => {
  if (pushSubscriptionRefreshSuppressed) return;
  event.waitUntil(refreshPushSubscription(event.oldSubscription));
});

sw.addEventListener('message', (event: ExtendableMessageEvent) => {
  const message = event.data as { type?: unknown } | null;
  if (message?.type === 'push-subscription-revoked') {
    pushSubscriptionRefreshSuppressed = true;
  } else if (message?.type === 'push-subscription-enabled') {
    pushSubscriptionRefreshSuppressed = false;
  }
});

function safeAppUrl(value: string): string {
  try {
    const url = new URL(value, sw.location.origin);
    return url.origin === sw.location.origin ? url.toString() : `${sw.location.origin}/`;
  } catch {
    return `${sw.location.origin}/`;
  }
}

function apiOrigin(): string {
  const url = new URL(sw.location.origin);
  if (url.hostname.startsWith('app.')) url.hostname = `api.${url.hostname.slice(4)}`;
  return url.origin;
}

function base64UrlBytes(value: string): Uint8Array<ArrayBuffer> {
  const padded = value
    .replaceAll('-', '+')
    .replaceAll('_', '/')
    .padEnd(Math.ceil(value.length / 4) * 4, '=');
  const binary = atob(padded);
  return Uint8Array.from(binary, (character) => character.charCodeAt(0));
}

async function refreshPushSubscription(oldSubscription: PushSubscription | null): Promise<void> {
  const origin = apiOrigin();
  const configResponse = await fetch(`${origin}/api/config/vapid-public-key`, {
    credentials: 'include',
  });
  if (!configResponse.ok) return;
  const config = (await configResponse.json()) as { publicKey?: string | null };
  if (!config.publicKey) return;
  const subscription = await sw.registration.pushManager.subscribe({
    userVisibleOnly: true,
    applicationServerKey: base64UrlBytes(config.publicKey),
  });
  await fetch(`${origin}/api/notifications/push/subscriptions`, {
    method: 'POST',
    credentials: 'include',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(subscription.toJSON()),
  });
  if (oldSubscription && oldSubscription.endpoint !== subscription.endpoint) {
    await fetch(`${origin}/api/notifications/push/subscriptions`, {
      method: 'DELETE',
      credentials: 'include',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ endpoint: oldSubscription.endpoint }),
    });
  }
}

async function networkFirstNavigation(request: Request): Promise<Response> {
  try {
    const response = await fetch(request);
    const cache = await caches.open(RUNTIME_CACHE);
    cache.put(request, response.clone());
    return response;
  } catch {
    const cached = await caches.match(request);
    if (cached) {
      return cached;
    }

    const shell = await caches.match('/index.html');
    if (shell) {
      return shell;
    }

    const offline = await caches.match(OFFLINE_URL);
    if (offline) {
      return offline;
    }

    return new Response('Offline', {
      status: 503,
      statusText: 'Offline',
      headers: { 'Content-Type': 'text/plain' },
    });
  }
}

async function staleWhileRevalidate(request: Request): Promise<Response> {
  const cache = await caches.open(RUNTIME_CACHE);
  const cached = await cache.match(request);

  const fetchPromise = fetch(request)
    .then((response) => {
      if (response && response.status === 200) {
        cache.put(request, response.clone());
      }
      return response;
    })
    .catch((): undefined => undefined);

  if (cached) {
    return cached;
  }

  const networkResponse = await fetchPromise;
  if (networkResponse) {
    return networkResponse;
  }

  return new Response('', { status: 504, statusText: 'Gateway Timeout' });
}
