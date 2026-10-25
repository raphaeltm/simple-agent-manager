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
});
