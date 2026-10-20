import type { APIRequestContext } from '@playwright/test';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Json } from '../playwright/staging-sam-dispatch-evidence';
import { dispatchReader } from '../playwright/staging-sam-dispatch-observation';

const response = (status: number) => ({ status: () => status, json: async () => ({ ok: true }) });
const check = (ok: boolean, label: string) => {
  if (!ok) throw new Error(label);
};
afterEach(() => vi.useRealTimers());
describe('bounded safe dispatch reads', () => {
  it('retains the failed status and recovers the same GET within one deadline', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValueOnce(response(500)).mockResolvedValueOnce(response(200));
    const ledger: Json = {};
    const pending = dispatchReader(
      { get } as unknown as APIRequestContext,
      ledger,
      check,
      1000
    )('https://api.test/api/workspaces/private-id?secret=hidden');
    await vi.runAllTimersAsync();
    expect(await pending).toEqual({ ok: true });
    expect(get).toHaveBeenCalledTimes(2);
    expect(get.mock.calls[1]?.[1].timeout).toBe(900);
    expect(ledger.readFailures).toEqual([
      { path: '/api/workspaces/:workspace', status: 500, attempt: 1 },
    ]);
    expect(JSON.stringify(ledger)).not.toContain('private-id');
    expect(JSON.stringify(ledger)).not.toContain('hidden');
  });
  it.each([500, 502, 503, 504])(
    'fails persistent %s after at most three attempts',
    async (status) => {
      vi.useFakeTimers();
      const get = vi.fn().mockResolvedValue(response(status));
      const pending = dispatchReader(
        { get } as unknown as APIRequestContext,
        {},
        check,
        1000
      )('https://api.test/api/workspaces');
      const assertion = expect(pending).rejects.toThrow('Scoped read HTTP');
      await vi.runAllTimersAsync();
      await assertion;
      expect(get).toHaveBeenCalledTimes(3);
    }
  );
  it.each([401, 403, 404, 429])('does not retry %s', async (status) => {
    const get = vi.fn().mockResolvedValue(response(status));
    await expect(
      dispatchReader(
        { get } as unknown as APIRequestContext,
        {},
        check,
        1000
      )('https://api.test/api/workspaces')
    ).rejects.toThrow('Scoped read HTTP');
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('stops recovery immediately when authorization fails on the next read', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockResolvedValueOnce(response(500)).mockResolvedValueOnce(response(401));
    const pending = dispatchReader(
      { get } as unknown as APIRequestContext,
      {},
      check,
      1000
    )('https://api.test/api/workspaces');
    const assertion = expect(pending).rejects.toThrow('Scoped read HTTP');
    await vi.runAllTimersAsync();
    await assertion;
    expect(get).toHaveBeenCalledTimes(2);
  });
  it('does not retry invalid JSON or unknown paths', async () => {
    const get = vi.fn().mockResolvedValue({
      status: () => 200,
      json: async () => {
        throw new Error('private body');
      },
    });
    await expect(
      dispatchReader(
        { get } as unknown as APIRequestContext,
        {},
        check,
        1000
      )('https://api.test/api/workspaces')
    ).rejects.toThrow('valid JSON');
    expect(get).toHaveBeenCalledTimes(1);
    get.mockClear().mockResolvedValue(response(500));
    await expect(
      dispatchReader(
        { get } as unknown as APIRequestContext,
        {},
        check,
        1000
      )('https://api.test/unknown')
    ).rejects.toThrow('Scoped read HTTP');
    expect(get).toHaveBeenCalledTimes(1);
  });
  it('does not start another request when the original deadline is exhausted', async () => {
    vi.useFakeTimers();
    const get = vi.fn().mockImplementation(async () => {
      vi.setSystemTime(Date.now() + 1000);
      return response(500);
    });
    await expect(
      dispatchReader(
        { get } as unknown as APIRequestContext,
        {},
        check,
        1000
      )('https://api.test/api/workspaces')
    ).rejects.toThrow('Scoped read HTTP');
    expect(get).toHaveBeenCalledTimes(1);
  });
});
