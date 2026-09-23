import { describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { getBetterAuthAccountIdForProvider } from '../../../src/services/better-auth-account';

type AccountRow = { id: string; userId: string; providerId: string };

function makeEnv(rows: AccountRow[]) {
  const first = vi.fn(async (userId: string, providerId: string) => {
    const row = rows.find((candidate) => {
      return candidate.userId === userId && candidate.providerId === providerId;
    });
    return row ? { id: row.id } : null;
  });
  const bind = vi.fn((userId: string, providerId: string) => ({
    first: () => first(userId, providerId),
  }));
  const prepare = vi.fn(() => ({ bind }));
  return { env: { DATABASE: { prepare } } as unknown as Env, prepare, bind };
}

describe('getBetterAuthAccountIdForProvider', () => {
  const rows: AccountRow[] = [
    { id: 'user-1-github', userId: 'user-1', providerId: 'github' },
    { id: 'user-1-gitlab', userId: 'user-1', providerId: 'gitlab' },
    { id: 'user-2-github', userId: 'user-2', providerId: 'github' },
  ];

  it.each([
    ['github', 'user-1-github'],
    ['gitlab', 'user-1-gitlab'],
  ] as const)(
    'binds the user before %s and selects that provider account',
    async (provider, id) => {
      const { env, prepare, bind } = makeEnv(rows);

      await expect(getBetterAuthAccountIdForProvider(env, 'user-1', provider)).resolves.toBe(id);
      expect(bind).toHaveBeenCalledWith('user-1', provider);
      expect(prepare).toHaveBeenCalledWith(
        expect.stringMatching(/user_id\s*=\s*\?1[\s\S]*provider_id\s*=\s*\?2/)
      );
    }
  );

  it('does not select another user account and returns null without an exact match', async () => {
    const { env, bind } = makeEnv(rows);

    await expect(getBetterAuthAccountIdForProvider(env, 'user-3', 'github')).resolves.toBeNull();
    expect(bind).toHaveBeenCalledWith('user-3', 'github');
  });
});
