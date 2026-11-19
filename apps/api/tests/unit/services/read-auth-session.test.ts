import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

const mocks = vi.hoisted(() => ({ createAuth: vi.fn(), settings: vi.fn() }));
vi.mock('../../../src/auth', () => ({ createAuth: mocks.createAuth }));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSettingDetailsMany: mocks.settings,
}));
import { createRequestScopedD1 } from '../../../src/lib/d1-session';
import { AppError } from '../../../src/middleware/error';
import { readAuthSession, withAuthReadDeadline } from '../../../src/services/read-auth-session';

beforeEach(() => {
  vi.useFakeTimers();
  vi.clearAllMocks();
  mocks.settings.mockResolvedValue([{ value: 100 }, { value: 2 }]);
});
afterEach(() => vi.useRealTimers());
const env = { DATABASE: {} } as Env;
const request = () => new Request('https://api.example.com/api/auth/get-session');

describe('bounded session reads', () => {
  it('retries a stalled handler and returns the subsequent real session response', async () => {
    mocks.createAuth
      .mockResolvedValueOnce({ handler: () => new Promise(() => undefined) })
      .mockResolvedValueOnce({ handler: () => Response.json({ user: { id: 'current' } }) });
    const result = readAuthSession(env, request());
    await vi.advanceTimersByTimeAsync(101);
    expect(await (await result).json()).toEqual({ user: { id: 'current' } });
    expect(mocks.createAuth).toHaveBeenCalledTimes(2);
  });
  it('bounds all attempts, returning an unavailable error rather than null session', async () => {
    mocks.createAuth.mockImplementation(() => new Promise(() => undefined));
    const result = readAuthSession(env, request());
    await vi.advanceTimersByTimeAsync(201);
    const response = await result;
    expect(response.status).toBe(503);
    expect(response.headers.get('Cache-Control')).toBe('no-store');
    expect(await response.json()).toMatchObject({ error: 'AUTH_UNAVAILABLE' });
    expect(mocks.createAuth).toHaveBeenCalledTimes(2);
  });
  it('bounds settings bootstrap and still permits recovery through the default budget', async () => {
    mocks.settings.mockImplementation(() => new Promise(() => undefined));
    mocks.createAuth.mockResolvedValue({
      handler: () => Response.json({ user: { id: 'recovered' } }),
    });
    const result = readAuthSession(env, request());
    await vi.advanceTimersByTimeAsync(5001);
    expect(await (await result).json()).toEqual({ user: { id: 'recovered' } });
  });
  it.each([401, 403])('returns denial HTTP%s unchanged without retrying', async (status) => {
    mocks.createAuth.mockResolvedValue({ handler: () => new Response('denied', { status }) });
    const response = await readAuthSession(env, request());
    expect(response.status).toBe(status);
    expect(await response.text()).toBe('denied');
    expect(mocks.createAuth).toHaveBeenCalledOnce();
  });
  it('does not swallow caller cancellation or start a retry', async () => {
    const controller = new AbortController();
    mocks.createAuth.mockImplementation(() => new Promise(() => undefined));
    const result = readAuthSession(env, new Request(request(), { signal: controller.signal }));
    const rejected = expect(result).rejects.toThrow('leave');
    await vi.advanceTimersByTimeAsync(0);
    controller.abort(new Error('leave'));
    await rejected;
    expect(mocks.createAuth).toHaveBeenCalledOnce();
  });
});

it.each([
  ['disabled', 0],
  ['first-primary', 2],
] as const)('preserves D1 session mode %s while retrying', async (mode, expectedSessions) => {
  const sessionPrepare = vi.fn(() => ({}));
  const raw = {
    prepare: vi.fn(() => ({})),
    withSession: vi.fn(() => ({ prepare: sessionPrepare })),
  } as unknown as D1Database;
  const original = createRequestScopedD1(raw, mode);
  let calls = 0;
  mocks.createAuth.mockImplementation(async (readEnv: Env) => {
    readEnv.DATABASE.prepare('SELECT 1');
    calls++;
    return {
      handler: () =>
        calls === 1 ? new Promise(() => undefined) : Response.json({ user: { id: 'fresh' } }),
    };
  });
  const result = readAuthSession({ DATABASE: original, D1_SESSION_MODE: mode } as Env, request());
  await vi.advanceTimersByTimeAsync(101);
  expect((await result).status).toBe(200);
  expect(raw.withSession).toHaveBeenCalledTimes(expectedSessions);
  const retryDatabase = mocks.createAuth.mock.calls[1]![0].DATABASE;
  if (mode === 'disabled') expect(retryDatabase).toBe(raw);
  else expect(retryDatabase).not.toBe(original);
});

it('preserves a thrown authorization denial without converting it to an outage', async () => {
  mocks.createAuth.mockResolvedValue({});
  const denial = new AppError(403, 'FORBIDDEN', 'Denied');
  await expect(
    withAuthReadDeadline(env, request(), async () => {
      throw denial;
    })
  ).rejects.toBe(denial);
  expect(mocks.createAuth).toHaveBeenCalledOnce();
});
