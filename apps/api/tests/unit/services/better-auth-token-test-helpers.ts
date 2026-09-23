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
