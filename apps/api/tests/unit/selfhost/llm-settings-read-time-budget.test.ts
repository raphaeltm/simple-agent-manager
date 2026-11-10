/**
 * The LLM endpoint settings read is a D1 query that runs before every task-title and diagnosis
 * model call. It must spend the call's own time budget: during a D1 hang a call may not wait for
 * the settings read's deadline on top of its own timeout.
 *
 * The D1 binding here really hangs: every statement waits on a gate the test opens only after
 * its assertions, so the settings read is genuinely in flight when the call's budget runs out.
 */
import type Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { __resetAdminSettingsCacheForTest } from '../../../src/services/admin-settings';
import { complete } from '../../../src/services/debug-agent-tools';
import { generateTaskTitle } from '../../../src/services/task-title';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const CLOUDFLARE = { CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'cf-token', AI_GATEWAY_ID: 'sam' };
const LONG_MESSAGE = 'Please refactor the billing reconciliation job so it '.repeat(10);
const BUDGET_MS = 60;
/** Well under the settings read's own 5 s deadline (DEFAULT_CONFIG_READ_TIMEOUT_MS). */
const WITHIN_BUDGET_MS = 1_500;

let sqlite: Database.Database;
let env: Env;
let openGate: () => void;
let fetchMock: ReturnType<typeof vi.fn>;

/** Wrap a D1 binding so every statement result waits on `gate` (a D1 hang the test controls). */
function hangingD1(real: D1Database, gate: Promise<void>): D1Database {
  const wrapStatement = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, prop, receiver) {
        const value = Reflect.get(target, prop, receiver) as unknown;
        if (typeof value !== 'function') return value;
        if (prop === 'bind') {
          return (...args: unknown[]) =>
            wrapStatement((value as (...a: unknown[]) => D1PreparedStatement).apply(target, args));
        }
        return async (...args: unknown[]) => {
          await gate;
          return (value as (...a: unknown[]) => unknown).apply(target, args);
        };
      },
    });
  return new Proxy(real, {
    get(target, prop, receiver) {
      if (prop === 'prepare') {
        return (query: string) => wrapStatement(target.prepare(query));
      }
      if (prop === 'batch') {
        return async (statements: D1PreparedStatement[]) => {
          await gate;
          return target.batch(statements);
        };
      }
      return Reflect.get(target, prop, receiver) as unknown;
    },
  });
}

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  ({ sqlite, env } = createAdminSettingsEnv());
  Object.assign(env, CLOUDFLARE);
  const gate = new Promise<void>((resolve) => {
    openGate = resolve;
  });
  env.DATABASE = hangingD1(env.DATABASE, gate);
  fetchMock = vi.fn(async () =>
    Response.json({ choices: [{ message: { role: 'assistant', content: 'late title' } }] })
  );
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
  vi.spyOn(console, 'error').mockImplementation(() => undefined);
});
afterEach(() => {
  openGate();
  sqlite.close();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('task title generation during a D1 hang', () => {
  it('falls back to truncation within its own timeout, once, without calling any model', async () => {
    const started = Date.now();
    const title = await generateTaskTitle(env, LONG_MESSAGE, {
      timeoutMs: BUDGET_MS,
      maxRetries: 2,
      retryDelayMs: 1,
    });
    const elapsed = Date.now() - started;

    expect(title.length).toBeGreaterThan(0);
    expect(LONG_MESSAGE.startsWith(title.replace(/\.\.\.$/, '').trimEnd())).toBe(true);
    expect(elapsed).toBeLessThan(WITHIN_BUDGET_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10_000);

  it('still generates a title when D1 answers (control)', async () => {
    openGate();
    const title = await generateTaskTitle(env, LONG_MESSAGE, { timeoutMs: 2_000 });
    expect(title).toBe('late title');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

describe('diagnosis model call during a D1 hang', () => {
  const config = { model: '@cf/test/diagnosis', timeoutMs: BUDGET_MS } as Parameters<
    typeof complete
  >[1];

  it('aborts within its own timeout without calling any model', async () => {
    const started = Date.now();
    await expect(complete(env, config, 'diagnosis-test', [], 64)).rejects.toThrow();
    expect(Date.now() - started).toBeLessThan(WITHIN_BUDGET_MS);
    expect(fetchMock).not.toHaveBeenCalled();
  }, 10_000);

  it('calls the Cloudflare route when D1 answers (control)', async () => {
    openGate();
    fetchMock.mockImplementation(async () =>
      Response.json({ choices: [{ message: { role: 'assistant', content: 'ok' } }] })
    );
    await complete(env, { ...config, timeoutMs: 2_000 }, 'diagnosis-test', [], 64);
    expect(String(fetchMock.mock.calls[0]?.[0])).toBe(
      'https://gateway.ai.cloudflare.com/v1/account-1/sam/workers-ai/v1/chat/completions'
    );
  });
});
