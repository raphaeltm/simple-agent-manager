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

    expect(await Promise.all([
      notification.claimNotificationDeduplication(key, 61_000, 1_000),
      notification.claimNotificationDeduplication(key, 61_000, 1_000),
    ])).toEqual([true, false]);

    expect(await notification.claimNotificationDeduplication(key, 121_001, 61_001)).toBe(true);
  });
});
