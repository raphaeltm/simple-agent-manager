import type { NotificationResponse } from '@simple-agent-manager/shared';
import { describe, expect, it, vi } from 'vitest';

import {
  buildDeclarativeWebPushPayload,
  deliverWebPushSubscription,
} from '../../../src/durable-objects/notification-push';

const NOTIFICATION: NotificationResponse = {
  id: 'notification-1',
  projectId: 'project-1',
  taskId: 'task-1',
  sessionId: 'session-1',
  type: 'needs_input',
  urgency: 'high',
  title: 'Approval needed',
  body: 'Choose a release window',
  actionUrl: '/projects/project-1/chat/session-1',
  metadata: null,
  readAt: null,
  dismissedAt: null,
  createdAt: '2026-08-11T00:00:00.000Z',
};

const SUBSCRIPTION = {
  endpoint: 'https://push.example.test/send/abc',
  userId: 'user-1',
  p256dh: 'receiver-public-key',
  auth: 'receiver-auth',
  userAgent: 'Test Browser',
  disabledAt: null,
  failureCount: 0,
  lastSuccessAt: null,
  createdAt: 1,
  updatedAt: 1,
};

const ENV = {
  VAPID_PUBLIC_KEY: 'vapid-public',
  VAPID_PRIVATE_KEY: 'vapid-private',
  VAPID_SUBJECT: 'mailto:admin@example.test',
};

describe('buildDeclarativeWebPushPayload', () => {
  it('builds one Declarative Web Push payload with an absolute click target', () => {
    expect(buildDeclarativeWebPushPayload(NOTIFICATION, 'https://app.example.test')).toEqual({
      web_push: 8030,
      notification: {
        title: 'Approval needed',
        body: 'Choose a release window',
        navigate: 'https://app.example.test/projects/project-1/chat/session-1',
        app_badge: '1',
      },
    });
  });

  it('does not allow an external notification action URL to become the click target', () => {
    expect(
      buildDeclarativeWebPushPayload(
        { ...NOTIFICATION, actionUrl: 'https://attacker.example' },
        'https://app.example.test'
      ).notification.navigate
    ).toBe('https://app.example.test/');
  });

  it.each(['//attacker.example/path', '/\\attacker.example/path'])(
    'rejects protocol-relative click target %s',
    (actionUrl) => {
      expect(
        buildDeclarativeWebPushPayload({ ...NOTIFICATION, actionUrl }, 'https://app.example.test')
          .notification.navigate
      ).toBe('https://app.example.test/');
    }
  );

  it('adds bounded structured-answer actions with same-origin deep links', () => {
    const payload = buildDeclarativeWebPushPayload(
      {
        ...NOTIFICATION,
        metadata: {
          attentionMarkerId: 'marker-1',
          options: ['Approve', 'Reject', 'Ask me later'],
        },
      },
      'https://app.example.test'
    );

    expect(payload.notification.actions).toEqual([
      {
        action: 'answer-0',
        title: 'Approve',
        navigate:
          'https://app.example.test/projects/project-1/chat/session-1#attentionMarker=marker-1&attentionAnswer=Approve',
      },
      {
        action: 'answer-1',
        title: 'Reject',
        navigate:
          'https://app.example.test/projects/project-1/chat/session-1#attentionMarker=marker-1&attentionAnswer=Reject',
      },
    ]);
  });
});

describe('deliverWebPushSubscription', () => {
  it('posts encrypted aes128gcm bytes with VAPID authorization', async () => {
    const fetcher = vi.fn().mockResolvedValue(new Response(null, { status: 201 }));
    const encrypt = vi.fn().mockResolvedValue(Uint8Array.of(1, 2, 3));
    const authorize = vi.fn().mockResolvedValue('vapid token');

    const result = await deliverWebPushSubscription(SUBSCRIPTION, '{"web_push":8030}', ENV, {
      fetcher,
      encrypt,
      authorize,
      now: () => 1000,
      sleep: vi.fn(),
    });

    expect(result).toEqual({ kind: 'success', attempts: 1, deliveredAt: 1000 });
    expect(fetcher).toHaveBeenCalledWith(
      SUBSCRIPTION.endpoint,
      expect.objectContaining({
        method: 'POST',
        redirect: 'manual',
        body: Uint8Array.of(1, 2, 3),
        headers: expect.objectContaining({
          Authorization: 'vapid token',
          'Content-Encoding': 'aes128gcm',
          TTL: '86400',
        }),
      })
    );
  });

  it.each([404, 410])('classifies HTTP %s as a scoped gone subscription', async (status) => {
    const result = await deliverWebPushSubscription(SUBSCRIPTION, '{}', ENV, {
      fetcher: vi.fn().mockResolvedValue(new Response(null, { status })),
      encrypt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
      authorize: vi.fn().mockResolvedValue('vapid token'),
      now: () => 1000,
      sleep: vi.fn(),
    });

    expect(result).toEqual({ kind: 'gone', attempts: 1, status });
  });

  it('retries a bounded Retry-After response and then succeeds', async () => {
    const sleep = vi.fn().mockResolvedValue(undefined);
    const fetcher = vi
      .fn()
      .mockResolvedValueOnce(
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '999' },
        })
      )
      .mockResolvedValueOnce(new Response(null, { status: 201 }));

    const result = await deliverWebPushSubscription(
      SUBSCRIPTION,
      '{}',
      {
        ...ENV,
        WEB_PUSH_MAX_ATTEMPTS: '2',
        WEB_PUSH_MAX_RETRY_AFTER_SECONDS: '3',
      },
      {
        fetcher,
        encrypt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
        authorize: vi.fn().mockResolvedValue('vapid token'),
        now: () => 1000,
        sleep,
      }
    );

    expect(result).toEqual({ kind: 'success', attempts: 2, deliveredAt: 1000 });
    expect(sleep).toHaveBeenCalledWith(3000);
  });

  it('returns a failure after the configured attempt bound', async () => {
    const result = await deliverWebPushSubscription(
      SUBSCRIPTION,
      '{}',
      {
        ...ENV,
        WEB_PUSH_MAX_ATTEMPTS: '1',
      },
      {
        fetcher: vi.fn().mockResolvedValue(new Response(null, { status: 503 })),
        encrypt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
        authorize: vi.fn().mockResolvedValue('vapid token'),
        now: () => 1000,
        sleep: vi.fn(),
      }
    );

    expect(result).toEqual({ kind: 'failure', attempts: 1, status: 503 });
  });

  it('does not sleep past the total background-delivery budget', async () => {
    const sleep = vi.fn();
    const result = await deliverWebPushSubscription(SUBSCRIPTION, '{}', ENV, {
      fetcher: vi.fn().mockResolvedValue(
        new Response(null, {
          status: 429,
          headers: { 'Retry-After': '30' },
        })
      ),
      encrypt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
      authorize: vi.fn().mockResolvedValue('vapid token'),
      now: () => 1_000,
      sleep,
    });

    expect(result).toEqual({ kind: 'failure', attempts: 1, status: 429 });
    expect(sleep).not.toHaveBeenCalled();
  });

  it('clamps an over-limit configured budget below the Worker background lifetime', async () => {
    const sleep = vi.fn();
    const result = await deliverWebPushSubscription(
      SUBSCRIPTION,
      '{}',
      { ...ENV, WEB_PUSH_DELIVERY_BUDGET_MS: '60000' },
      {
        fetcher: vi.fn().mockResolvedValue(
          new Response(null, {
            status: 429,
            headers: { 'Retry-After': '30' },
          })
        ),
        encrypt: vi.fn().mockResolvedValue(Uint8Array.of(1)),
        authorize: vi.fn().mockResolvedValue('vapid token'),
        now: () => 1_000,
        sleep,
      }
    );

    expect(result).toEqual({ kind: 'failure', attempts: 1, status: 429 });
    expect(sleep).not.toHaveBeenCalled();
  });
});
