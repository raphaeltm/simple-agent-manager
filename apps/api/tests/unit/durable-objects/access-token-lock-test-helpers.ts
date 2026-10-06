import { expect, vi } from 'vitest';

export function makeDatabaseBinding(accountId: string | null = 'account-row') {
  return {
    prepare: vi.fn(() => ({
      bind: vi.fn(() => ({
        first: vi.fn(async () => (accountId ? { id: accountId } : null)),
      })),
    })),
  };
}

export function makeBetterAuthAccountEnv(accountId: string | null) {
  const first = vi.fn(async () => (accountId ? { id: accountId } : null));
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn(() => ({ bind }));
  return {
    env: { DATABASE: { prepare } },
    prepare,
    bind,
    first,
  };
}

export function makeAccessTokenLockRequest(
  url: string,
  options?: { userId?: string; includeHeaders?: boolean; flow?: string }
): Request {
  const userId = options?.userId ?? 'user-1';
  const flow = options?.flow ?? 'test';
  const includeHeaders = options?.includeHeaders ?? true;

  return new Request(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      userId,
      flow,
      ...(includeHeaders ? { headers: [['cookie', 'session=abc']] } : {}),
    }),
  });
}

export function expectBetterAuthTokenLookup(
  getAccessToken: { mock: { calls: unknown[][] } },
  accountId: string,
  userId = 'user-1'
): void {
  expect(getAccessToken).toHaveBeenCalledWith(
    expect.objectContaining({
      body: { accountId, userId },
    })
  );
}

export function expectTrustedOwnerTokenLookup(
  getAccessToken: { mock: { calls: unknown[][] } },
  accountId: string,
  userId = 'user-1'
): void {
  expect(getAccessToken).toHaveBeenCalledWith({
    body: { accountId, userId },
  });
}
