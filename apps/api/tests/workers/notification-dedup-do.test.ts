import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

import type { NotificationService } from '../../src/durable-objects/notification';

function stub(userId: string): DurableObjectStub<NotificationService> {
  return env.NOTIFICATION.get(
    env.NOTIFICATION.idFromName(userId)
  ) as DurableObjectStub<NotificationService>;
}

describe('Notification DO expiring deduplication claims', () => {
  it('serializes concurrent claims and permits a new claim only after expiry', async () => {
    const notification = stub('notification-dedup-user-001');
    const key = 'cron-failure-notification:node_cleanup';

    expect(
      await Promise.all([
        notification.claimNotificationDeduplication(key, 61_000, 1_000),
        notification.claimNotificationDeduplication(key, 61_000, 1_000),
      ])
    ).toEqual([true, false]);

    expect(await notification.claimNotificationDeduplication(key, 121_001, 61_001)).toBe(true);
  });

  it('points a deduplicated question notification at the newest question', async () => {
    const userId = `notification-question-user-${crypto.randomUUID()}`;
    const notification = stub(userId);
    const ask = (markerId: string, options: string[]) =>
      notification.createNotification(userId, {
        type: 'needs_input',
        urgency: 'high',
        title: `Decision needed (${markerId})`,
        body: `Question ${markerId}`,
        projectId: 'project-1',
        taskId: 'task-1',
        sessionId: 'session-1',
        metadata: { attentionMarkerId: markerId, category: 'decision', options },
      });

    const first = await ask('marker-old', ['A', 'B']);
    const second = await ask('marker-new', ['C']);

    // One unread notification for the task, now describing the newer question: answering from
    // it must target marker-new, not the question it replaced.
    expect(second.id).toBe(first.id);
    const { notifications } = await notification.listNotifications(userId, { filter: 'unread' });
    expect(notifications).toHaveLength(1);
    expect(notifications[0]).toMatchObject({
      body: 'Question marker-new',
      metadata: { attentionMarkerId: 'marker-new', options: ['C'] },
    });
  });

  it('never merges a result into an open question, and merges repeat results onto the newest', async () => {
    const userId = `notification-result-user-${crypto.randomUUID()}`;
    const notification = stub(userId);
    const base = {
      type: 'needs_input' as const,
      urgency: 'high' as const,
      projectId: 'project-1',
      taskId: 'task-1',
      sessionId: 'session-1',
    };
    const question = await notification.createNotification(userId, {
      ...base,
      title: 'Decision needed: ship it?',
      body: 'Ship the fix now?',
      actionUrl: '/projects/project-1/chat/session-1',
      metadata: { attentionMarkerId: 'q-1', options: ['Yes', 'No'] },
    });
    const result = (id: string) =>
      notification.createNotification(userId, {
        ...base,
        title: `Result ready: ${id}`,
        body: `Details ${id}`,
        actionUrl: `/projects/project-1/inbox?item=ask%3A${id}`,
        metadata: { attentionMarkerId: id, options: null, inboxKind: 'result' },
      });
    const first = await result('r-1');
    const second = await result('r-2');

    // The question keeps its own notification, untouched by either result.
    expect(first.id).not.toBe(question.id);
    expect(second.id).toBe(first.id);
    const { notifications } = await notification.listNotifications(userId, { filter: 'unread' });
    expect(notifications).toHaveLength(2);
    expect(notifications.find((n) => n.id === question.id)).toMatchObject({
      title: 'Decision needed: ship it?',
      metadata: { attentionMarkerId: 'q-1' },
    });
    // The merged result notification names and opens the newest result.
    expect(notifications.find((n) => n.id === first.id)).toMatchObject({
      title: 'Result ready: r-2',
      actionUrl: '/projects/project-1/inbox?item=ask%3Ar-2',
      metadata: { attentionMarkerId: 'r-2', inboxKind: 'result' },
    });
  });
});
