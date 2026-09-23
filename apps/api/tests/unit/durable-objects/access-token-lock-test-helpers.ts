import { vi } from 'vitest';

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
