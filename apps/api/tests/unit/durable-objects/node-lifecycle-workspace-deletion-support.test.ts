import { describe, expect, it } from 'vitest';

import { workspaceDeletionRetryDelayMs } from '../../../src/durable-objects/node-lifecycle-workspace-deletion-support';

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
