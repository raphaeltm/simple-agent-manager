/**
 * The Cloudflare account-scoped REST APIs (Analytics Engine SQL, Workers Observability) on an
 * installation with and without a Cloudflare account.
 *
 * - Admin analytics routes mounted behind the real global error handler.
 * - runAnalyticsForward (the daily cron) with forwarding enabled.
 * - queryWorkerLogs (behind Admin -> Logs and the `ops_query_worker_logs` tool).
 *
 * `fetch` is the only mock at the boundary; admin settings run against the real SQLite-backed
 * settings tables so timeouts resolve the way production resolves them.
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { AppError } from '../../../src/middleware/error';
import { adminAnalyticsRoutes } from '../../../src/routes/admin-analytics';
import { runAnalyticsForward } from '../../../src/services/analytics-forward';
import { queryWorkerLogs } from '../../../src/services/worker-log-query';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireApproved: () => async (_c: unknown, next: () => Promise<void>) => next(),
  requireSuperadmin: () => async (_c: unknown, next: () => Promise<void>) => next(),
}));

let sqlite: Database.Database;
let baseEnv: Env;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  ({ sqlite, env: baseEnv } = createAdminSettingsEnv({ ANALYTICS_DATASET: 'sam_analytics' }));
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
  vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  sqlite.close();
});

const cloudflare = (): Env =>
  ({ ...baseEnv, CF_ACCOUNT_ID: 'account-1', CF_API_TOKEN: 'token-1' }) as Env;
/**
 * A runtime with no Cloudflare account. The Cloudflare deploy generates ANALYTICS_DATASET, so a
 * self-hosted box has none either; the celld run failed with a 500 for exactly this shape.
 */
const selfHosted = (): Env => ({ ...baseEnv, ANALYTICS_DATASET: undefined }) as Env;

describe('admin analytics routes', () => {
  function app() {
    const testApp = new Hono<{ Bindings: Env }>();
    testApp.onError(handleAppError);
    testApp.route('/api/admin/analytics', adminAnalyticsRoutes);
    return testApp;
  }

  it('GET /dau queries the Cloudflare analytics SQL API when an account is configured (Cloudflare behaviour)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({ data: [{ date: '2026-11-09', unique_users: '4' }] }),
        { status: 200 }
      )
    );

    const res = await app().request('/api/admin/analytics/dau', {}, cloudflare());

    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({
      dau: [{ date: '2026-11-09', unique_users: 4 }],
      periodDays: expect.any(Number),
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/account-1/analytics_engine/sql');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(String(init.body)).toContain('sam_analytics');
  });

  it.each(['dau', 'events', 'funnel', 'feature-adoption', 'geo', 'retention', 'website-traffic'])(
    'GET /%s answers 404 FEATURE_UNAVAILABLE for analyticsQuery without an account, and never calls fetch',
    async (route) => {
      const res = await app().request(`/api/admin/analytics/${route}`, {}, selfHosted());

      expect(res.status).toBe(404);
      expect(await res.json()).toEqual({
        error: 'FEATURE_UNAVAILABLE',
        message: 'Analytics is not available on this installation',
        details: { feature: 'analyticsQuery' },
      });
      expect(fetchMock).not.toHaveBeenCalled();
    }
  );

  it('answers 404 when only the account id is set (the token is half of the credential)', async () => {
    const res = await app().request(
      '/api/admin/analytics/dau',
      {},
      { ...baseEnv, CF_ACCOUNT_ID: 'account-1' } as Env
    );

    expect(res.status).toBe(404);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('keeps GET /forward-status working without an account (it never queries Cloudflare)', async () => {
    const res = await app().request('/api/admin/analytics/forward-status', {}, selfHosted());

    expect(res.status).toBe(200);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('runAnalyticsForward', () => {
  const forwardingOn = { ANALYTICS_FORWARD_ENABLED: 'true' };

  it('queries the analytics SQL API when forwarding is on and an account is configured (Cloudflare behaviour)', async () => {
    fetchMock.mockResolvedValue(new Response(JSON.stringify({ data: [] }), { status: 200 }));

    const result = await runAnalyticsForward({ ...cloudflare(), ...forwardingOn } as Env);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(String((fetchMock.mock.calls[0] as [string])[0])).toContain(
      '/accounts/account-1/analytics_engine/sql'
    );
    expect(result).toMatchObject({ enabled: true, eventsQueried: 0 });
    expect(result.skipReason).toBeUndefined();
  });

  it('resolves with skipReason analytics_query_unavailable, without throwing or fetching, when there is no account', async () => {
    const result = await runAnalyticsForward({ ...selfHosted(), ...forwardingOn } as Env);

    expect(result).toEqual({
      enabled: false,
      skipReason: 'analytics_query_unavailable',
      eventsQueried: 0,
      segment: { sent: 0, batches: 0, enabled: false },
      ga4: { sent: 0, batches: 0, enabled: false },
      cursorUpdated: false,
      newCursor: null,
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reports no skip reason when forwarding is simply switched off (a different, intended state)', async () => {
    const result = await runAnalyticsForward(selfHosted());

    expect(result.enabled).toBe(false);
    expect('skipReason' in result).toBe(false);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});

describe('queryWorkerLogs', () => {
  const query = {
    timeRange: { start: '2026-11-10T11:00:00Z', end: '2026-11-10T12:00:00Z' },
    levels: ['error'],
    scriptName: 'sam-api-staging',
  };

  it('calls the Workers Observability API with the account and token when configured (Cloudflare behaviour)', async () => {
    fetchMock.mockResolvedValue(
      new Response(
        JSON.stringify({
          result: {
            events: {
              events: [
                {
                  $metadata: { id: 'inv-1', level: 'error', message: 'boom' },
                  $workers: { scriptName: 'sam-api-staging' },
                  timestamp: Date.parse('2026-11-10T11:30:00Z'),
                },
              ],
            },
          },
        }),
        { status: 200 }
      )
    );

    const result = await queryWorkerLogs(cloudflare(), query);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, init] = fetchMock.mock.calls[0] as [string, RequestInit];
    expect(url).toContain('/accounts/account-1/workers/observability/telemetry/query');
    expect((init.headers as Record<string, string>).Authorization).toBe('Bearer token-1');
    expect(JSON.parse(String(init.body))).toMatchObject({
      parameters: { filters: expect.arrayContaining([expect.objectContaining({ value: 'sam-api-staging' })]) },
    });
    expect(result.logs).toHaveLength(1);
    expect(result.logs[0]).toMatchObject({ level: 'error' });
  });

  it('throws a 404 FEATURE_UNAVAILABLE AppError for workersObservability without an account, with no fetch', async () => {
    const failure = await queryWorkerLogs(selfHosted(), query).then(
      () => null,
      (err: unknown) => err
    );

    expect(failure).toBeInstanceOf(AppError);
    expect(failure).toMatchObject({
      statusCode: 404,
      error: 'FEATURE_UNAVAILABLE',
      details: { feature: 'workersObservability' },
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('still validates input once an account is configured (the guard does not swallow 400s)', async () => {
    await expect(
      queryWorkerLogs(cloudflare(), { ...query, levels: ['loud'] })
    ).rejects.toMatchObject({ statusCode: 400 });
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
