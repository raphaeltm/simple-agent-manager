import { beforeEach, describe, expect, it, vi } from 'vitest';

const { sendNotificationMock } = vi.hoisted(() => ({ sendNotificationMock: vi.fn() }));
vi.mock('../../../src/services/notification', () => ({
  sendNotification: sendNotificationMock,
}));

import type { Env } from '../../../src/env';
import { notifyFailedSweeps } from '../../../src/scheduled/failed-sweep-notifications';

function makeEnv() {
  const values = new Map<string, string>();
  const bind = vi.fn(() => ({
    all: vi.fn(async () => ({ results: [{ id: 'admin-1' }, { id: 'admin-2' }] })),
  }));
  const prepare = vi.fn(() => ({ bind }));
  const env = {
    DATABASE: { prepare },
    KV: {
      get: vi.fn(async (key: string) => values.get(key) ?? null),
      put: vi.fn(async (key: string, value: string) => { values.set(key, value); }),
    },
    NOTIFICATION: {},
    TRIAL_ANONYMOUS_USER_ID: 'system-sentinel',
  } as unknown as Env;
  return { env, bind, prepare };
}

describe('failed sweep notifications', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sendNotificationMock.mockResolvedValue(undefined);
  });

  it('notifies real superadmins once per sweep name per throttle window', async () => {
    const { env, bind, prepare } = makeEnv();

    expect(await notifyFailedSweeps(env, ['node_cleanup'])).toEqual({
      notifiedSweeps: 1,
      notificationsSent: 2,
    });
    expect(await notifyFailedSweeps(env, ['node_cleanup'])).toEqual({
      notifiedSweeps: 0,
      notificationsSent: 0,
    });
    expect(sendNotificationMock).toHaveBeenCalledTimes(2);
    expect(bind).toHaveBeenCalledWith('system-sentinel');
    expect(prepare.mock.calls[0]![0]).toContain("status != 'system'");
  });

  it('throttles each sweep independently', async () => {
    const { env } = makeEnv();
    await notifyFailedSweeps(env, ['node_cleanup', 'stuck_tasks']);
    expect(sendNotificationMock).toHaveBeenCalledTimes(4);
  });

  it('does not send when the throttle KV cannot enforce the spam bound', async () => {
    const { env } = makeEnv();
    vi.mocked(env.KV.get).mockRejectedValue(new Error('KV unavailable'));
    await notifyFailedSweeps(env, ['node_cleanup']);
    expect(sendNotificationMock).not.toHaveBeenCalled();
  });
});
