import { describe, expect, it } from 'vitest';

import { workspaceDeletionDueIndexKey } from '../../../src/durable-objects/node-lifecycle-workspace-deletion';
import {
  workspaceDeletionAlarmBatchSize,
  workspaceDeletionRetryDelayMs,
} from '../../../src/durable-objects/node-lifecycle-workspace-deletion-support';

describe('workspaceDeletionRetryDelayMs', () => {
  it('saturates at the configured maximum without an operation-count ceiling', () => {
    const env = {
      WORKSPACE_DELETION_RETRY_BASE_MS: '1',
      WORKSPACE_DELETION_RETRY_MAX_MS: String(2 ** 40),
    } as never;

    expect(workspaceDeletionRetryDelayMs(env, 32)).toBe(2 ** 31);
    expect(workspaceDeletionRetryDelayMs(env, 41)).toBe(2 ** 40);
    expect(workspaceDeletionRetryDelayMs(env, 100_000)).toBe(2 ** 40);
  });
});

describe('workspaceDeletionAlarmBatchSize', () => {
  it('defaults to the Free-plan-safe D1 query budget and accepts an explicit override', () => {
    expect(workspaceDeletionAlarmBatchSize({} as never)).toBe(4);
    expect(
      workspaceDeletionAlarmBatchSize({ WORKSPACE_DELETION_ALARM_BATCH_SIZE: '2' } as never)
    ).toBe(2);
  });
});

describe('workspaceDeletionDueIndexKey', () => {
  it('sorts live entries by due time without embedding deletion payloads', () => {
    const later = workspaceDeletionDueIndexKey({
      workspaceId: 'workspace-later',
      userId: 'user-1',
      deleteAt: 20_000,
    });
    const earlier = workspaceDeletionDueIndexKey({
      workspaceId: 'workspace-earlier',
      userId: 'user-1',
      deleteAt: 3_000,
    });

    expect([later, earlier].sort()).toEqual([earlier, later]);
    expect(earlier).not.toContain('user-1');
  });
});
