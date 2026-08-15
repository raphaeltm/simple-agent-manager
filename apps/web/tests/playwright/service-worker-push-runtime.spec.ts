import { expect, test } from '@playwright/test';

test.use({
  permissions: ['notifications'],
  serviceWorkers: 'allow',
});

test('the built service worker displays a push and deep-links its notification click', async ({
  context,
  page,
}) => {
  test.skip(
    process.env.PLAYWRIGHT_HEADED_PUSH !== '1',
    'Chromium headless disables notification delivery; run this audit headed with PLAYWRIGHT_HEADED_PUSH=1.'
  );

  const cdp = await context.newCDPSession(page);
  await cdp.send('ServiceWorker.enable');
  const registrationId = new Promise<string>((resolve) => {
    cdp.on('ServiceWorker.workerRegistrationUpdated', (event) => {
      const registration = event.registrations.find(
        (candidate) => !candidate.isDeleted && candidate.scopeURL === 'http://localhost:4173/'
      );
      if (registration) resolve(registration.registrationId);
    });
  });

  await page.goto('/', { waitUntil: 'load' });
  await page.evaluate(async () => navigator.serviceWorker.ready);
  expect(await page.evaluate(() => Notification.permission)).toBe('granted');

  const target = 'http://localhost:4173/try?from=web-push';
  await cdp.send('ServiceWorker.deliverPushMessage', {
    origin: 'http://localhost:4173',
    registrationId: await registrationId,
    data: JSON.stringify({
      web_push: 8030,
      notification: {
        title: 'Browser push verification',
        body: 'Open the deep link',
        navigate: target,
        app_badge: '1',
      },
    }),
  });

  await expect
    .poll(() =>
      page.evaluate(async () => {
        const registration = await navigator.serviceWorker.ready;
        const [notification] = await registration.getNotifications();
        const data = notification?.data as { navigate?: unknown } | undefined;
        return notification
          ? {
              title: notification.title,
              body: notification.body,
              navigate: data?.navigate,
            }
          : null;
      })
    )
    .toEqual({
      title: 'Browser push verification',
      body: 'Open the deep link',
      navigate: target,
    });

  await expect.poll(() => context.serviceWorkers().length).toBeGreaterThan(0);
  const worker = context.serviceWorkers().find((candidate) => candidate.url().endsWith('/sw.js'));
  if (!worker) throw new Error('Expected the built /sw.js worker to be active');
  const clicked = await worker.evaluate(async () => {
    const scope = globalThis as unknown as {
      registration: ServiceWorkerRegistration;
      dispatchEvent: (event: Event) => boolean;
      NotificationEvent: new (type: string, init: { notification: Notification }) => Event;
    };
    const [notification] = await scope.registration.getNotifications();
    if (!notification) return false;
    scope.dispatchEvent(new scope.NotificationEvent('notificationclick', { notification }));
    await new Promise((resolve) => setTimeout(resolve, 250));
    return true;
  });

  expect(clicked).toBe(true);
  await expect(page).toHaveURL(target);
});
