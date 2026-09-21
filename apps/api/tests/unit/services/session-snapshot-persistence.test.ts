import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { recordSessionSnapshotRestoreResult } from '../../../src/services/session-snapshot-persistence';

describe('session snapshot restore result persistence', () => {
  it('redacts, normalizes, and caps restore diagnostics before writing D1', async () => {
    const where = vi.fn().mockResolvedValue(undefined);
    const set = vi.fn(() => ({ where }));
    const db = { update: vi.fn(() => ({ set })) };
    const env = { SESSION_LIFECYCLE_ERROR_MAX_LENGTH: '80' } as unknown as Env;
    const secret = 'https://user:password@example.invalid/repo?access_token=query-secret';

    await recordSessionSnapshotRestoreResult(db as never, env, {
      chatSessionId: 'chat-1',
      status: 'git_failed',
      message: `fatal:\n${secret}\u0000${'x'.repeat(200)}`,
    });

    expect(set).toHaveBeenCalledOnce();
    const persisted = set.mock.calls[0]?.[0]?.restoreMessage as string;
    expect(persisted).not.toContain('password');
    expect(persisted).not.toContain('query-secret');
    expect(
      Array.from(persisted).some((character) => {
        const code = character.codePointAt(0) ?? 0;
        return code < 0x20 || code === 0x7f;
      })
    ).toBe(false);
    expect(persisted.length).toBeLessThanOrEqual(80);
  });
});
