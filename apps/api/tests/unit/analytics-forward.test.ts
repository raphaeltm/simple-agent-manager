import { describe, it, expect, vi, beforeEach } from 'vitest';
import {
  queryConversionEvents,
  forwardToSegment,
  forwardToGA4,
  runAnalyticsForward,
  getForwardStatus,
  type AnalyticsEvent,
} from '../../src/services/analytics-forward';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeEvent(overrides: Partial<AnalyticsEvent> = {}): AnalyticsEvent {
  return {
    timestamp: '2026-03-27T10:00:00Z',
    userId: 'user-1',
    event: 'signup',
    projectId: '',
    route: '/api/auth/signup',
    utmSource: '',
    utmMedium: '',
    utmCampaign: '',
    country: 'US',
    responseTimeMs: 120,
    statusCode: 200,
    ...overrides,
  };
}

function makeEnv(overrides: Record<string, unknown> = {}): any {
  return {
    CF_ACCOUNT_ID: 'test-account',
    CF_API_TOKEN: 'test-token',
    ANALYTICS_DATASET: 'sam_analytics',
    ANALYTICS_SQL_API_URL: 'https://api.cloudflare.com/client/v4/accounts',
    KV: {
      get: vi.fn().mockResolvedValue(null),
      put: vi.fn().mockResolvedValue(undefined),
    },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// queryConversionEvents
// ---------------------------------------------------------------------------

describe('queryConversionEvents', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('queries Analytics Engine SQL API with correct parameters', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [makeEvent()] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv();
    const events = await queryConversionEvents(env, '2026-03-26T00:00:00Z', ['signup', 'login']);

    expect(mockFetch).toHaveBeenCalledOnce();
    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.cloudflare.com/client/v4/accounts/test-account/analytics_engine/sql');
    expect(options.method).toBe('POST');
    expect(options.headers['Authorization']).toBe('Bearer test-token');
    expect(options.body).toContain("'signup'");
    expect(options.body).toContain("'login'");
    expect(options.body).toContain('2026-03-26T00:00:00Z');
    expect(events).toHaveLength(1);
  });

  it('throws when CF_ACCOUNT_ID is missing', async () => {
    const env = makeEnv({ CF_ACCOUNT_ID: undefined });
    await expect(queryConversionEvents(env, '2026-03-26T00:00:00Z', ['signup']))
      .rejects.toThrow('CF_ACCOUNT_ID is not configured');
  });

  it('throws on non-ok response', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Internal error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv();
    await expect(queryConversionEvents(env, '2026-03-26T00:00:00Z', ['signup']))
      .rejects.toThrow('Analytics Engine query failed: 500');
  });

  it('returns empty array when no data', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: undefined }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv();
    const events = await queryConversionEvents(env, '2026-03-26T00:00:00Z', ['signup']);
    expect(events).toEqual([]);
  });

  it('rejects invalid ISO timestamps to prevent SQL injection', async () => {
    const env = makeEnv();
    await expect(queryConversionEvents(env, "'; DROP TABLE --", ['signup']))
      .rejects.toThrow('Invalid ISO timestamp for cursor');
  });

  it('accepts valid ISO timestamps', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv();
    const events = await queryConversionEvents(env, '2026-03-27T10:00:00Z', ['signup']);
    expect(events).toEqual([]);
  });

  it('escapes single quotes in event names', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv();
    await queryConversionEvents(env, '2026-03-26T00:00:00Z', ["event'name"]);

    const sql = mockFetch.mock.calls[0][1].body;
    expect(sql).toContain("'event''name'");
  });
});

// ---------------------------------------------------------------------------
// forwardToSegment
// ---------------------------------------------------------------------------

describe('forwardToSegment', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips when SEGMENT_WRITE_KEY is not set', async () => {
    const env = makeEnv();
    const result = await forwardToSegment(env, [makeEvent()]);
    expect(result.sent).toBe(0);
    expect(result.batches).toBe(0);
  });

  it('sends events in correct Segment batch format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({ SEGMENT_WRITE_KEY: 'test-key' });
    const events = [makeEvent(), makeEvent({ userId: 'user-2', event: 'login' })];
    const result = await forwardToSegment(env, events);

    expect(result.sent).toBe(2);
    expect(result.batches).toBe(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toBe('https://api.segment.io/v1/batch');
    expect(options.headers['Authorization']).toBe(`Basic ${btoa('test-key:')}`);
    expect(options.headers['Content-Type']).toBe('application/json');

    const body = JSON.parse(options.body);
    expect(body.batch).toHaveLength(2);
    expect(body.batch[0].type).toBe('track');
    expect(body.batch[0].userId).toBe('user-1');
    expect(body.batch[0].event).toBe('signup');
    expect(body.batch[0].properties.country).toBe('US');
    expect(body.batch[0].context.library.name).toBe('sam-analytics-forward');
  });

  it('splits events into batches based on SEGMENT_MAX_BATCH_SIZE', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({ SEGMENT_WRITE_KEY: 'test-key', SEGMENT_MAX_BATCH_SIZE: '2' });
    const events = [makeEvent(), makeEvent(), makeEvent()];
    const result = await forwardToSegment(env, events);

    expect(result.sent).toBe(3);
    expect(result.batches).toBe(2);
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses custom SEGMENT_API_URL when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      SEGMENT_WRITE_KEY: 'test-key',
      SEGMENT_API_URL: 'https://custom.segment.io/v1/batch',
    });
    await forwardToSegment(env, [makeEvent()]);

    expect(mockFetch.mock.calls[0][0]).toBe('https://custom.segment.io/v1/batch');
  });

  it('returns error on API failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 429,
      text: () => Promise.resolve('Rate limited'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({ SEGMENT_WRITE_KEY: 'test-key' });
    const result = await forwardToSegment(env, [makeEvent()]);

    expect(result.sent).toBe(0);
    expect(result.error).toContain('429');
  });
});

// ---------------------------------------------------------------------------
// forwardToGA4
// ---------------------------------------------------------------------------

describe('forwardToGA4', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('skips when GA4_MEASUREMENT_ID is not set', async () => {
    const env = makeEnv();
    const result = await forwardToGA4(env, [makeEvent()]);
    expect(result.sent).toBe(0);
    expect(result.batches).toBe(0);
  });

  it('skips when GA4_API_SECRET is not set', async () => {
    const env = makeEnv({ GA4_MEASUREMENT_ID: 'G-123' });
    const result = await forwardToGA4(env, [makeEvent()]);
    expect(result.sent).toBe(0);
    expect(result.batches).toBe(0);
  });

  it('sends events in correct GA4 format', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({ GA4_MEASUREMENT_ID: 'G-123', GA4_API_SECRET: 'secret' });
    const events = [makeEvent()];
    const result = await forwardToGA4(env, events);

    expect(result.sent).toBe(1);
    expect(result.batches).toBe(1);

    const [url, options] = mockFetch.mock.calls[0];
    expect(url).toContain('measurement_id=G-123');
    expect(url).toContain('api_secret=secret');

    const body = JSON.parse(options.body);
    expect(body.client_id).toBe('user-1');
    expect(body.user_id).toBe('user-1');
    expect(body.events).toHaveLength(1);
    expect(body.events[0].name).toBe('signup');
    expect(body.events[0].params.country).toBe('US');
  });

  it('groups events by userId for GA4 requests', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({ GA4_MEASUREMENT_ID: 'G-123', GA4_API_SECRET: 'secret' });
    const events = [
      makeEvent({ userId: 'user-1' }),
      makeEvent({ userId: 'user-1', event: 'login' }),
      makeEvent({ userId: 'user-2', event: 'signup' }),
    ];
    const result = await forwardToGA4(env, events);

    expect(result.sent).toBe(3);
    // 2 requests: one for user-1 (2 events), one for user-2 (1 event)
    expect(mockFetch).toHaveBeenCalledTimes(2);
  });

  it('uses custom GA4_API_URL when provided', async () => {
    const mockFetch = vi.fn().mockResolvedValue({ ok: true });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      GA4_MEASUREMENT_ID: 'G-123',
      GA4_API_SECRET: 'secret',
      GA4_API_URL: 'https://custom.ga4.example/mp/collect',
    });
    await forwardToGA4(env, [makeEvent()]);

    expect(mockFetch.mock.calls[0][0]).toContain('https://custom.ga4.example/mp/collect');
  });

  it('returns error on API failure', async () => {
    const mockFetch = vi.fn().mockResolvedValue({
      ok: false,
      status: 500,
      text: () => Promise.resolve('Server error'),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({ GA4_MEASUREMENT_ID: 'G-123', GA4_API_SECRET: 'secret' });
    const result = await forwardToGA4(env, [makeEvent()]);
    expect(result.error).toContain('500');
  });
});

// ---------------------------------------------------------------------------
// runAnalyticsForward (orchestrator)
// ---------------------------------------------------------------------------

describe('runAnalyticsForward', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
  });

  it('returns disabled when ANALYTICS_FORWARD_ENABLED is not set', async () => {
    const env = makeEnv();
    const result = await runAnalyticsForward(env);
    expect(result.enabled).toBe(false);
    expect(result.eventsQueried).toBe(0);
  });

  it('returns disabled when ANALYTICS_FORWARD_ENABLED is "false"', async () => {
    const env = makeEnv({ ANALYTICS_FORWARD_ENABLED: 'false' });
    const result = await runAnalyticsForward(env);
    expect(result.enabled).toBe(false);
  });

  it('queries events and forwards to Segment when enabled', async () => {
    const events = [makeEvent(), makeEvent({ timestamp: '2026-03-27T11:00:00Z', event: 'login' })];

    // First call: Analytics Engine query; second call: Segment batch
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: events }),
      })
      .mockResolvedValueOnce({ ok: true });

    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      ANALYTICS_FORWARD_ENABLED: 'true',
      SEGMENT_WRITE_KEY: 'test-key',
    });
    const result = await runAnalyticsForward(env);

    expect(result.enabled).toBe(true);
    expect(result.eventsQueried).toBe(2);
    expect(result.segment.sent).toBe(2);
    expect(result.segment.enabled).toBe(true);
    expect(result.ga4.enabled).toBe(false);
    expect(result.cursorUpdated).toBe(true);
    expect(result.newCursor).toBe('2026-03-27T11:00:00Z');
    expect(env.KV.put).toHaveBeenCalledWith('analytics-forward-cursor', '2026-03-27T11:00:00Z');
  });

  it('reads stored cursor from KV', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      ANALYTICS_FORWARD_ENABLED: 'true',
      KV: {
        get: vi.fn().mockResolvedValue('2026-03-26T12:00:00Z'),
        put: vi.fn().mockResolvedValue(undefined),
      },
    });
    const result = await runAnalyticsForward(env);

    expect(env.KV.get).toHaveBeenCalledWith('analytics-forward-cursor');
    expect(result.eventsQueried).toBe(0);
    expect(result.cursorUpdated).toBe(false);

    // Verify SQL query used the stored cursor
    const sql = mockFetch.mock.calls[0][1].body;
    expect(sql).toContain('2026-03-26T12:00:00Z');
  });

  it('does not update cursor when no destination succeeds', async () => {
    const events = [makeEvent()];

    // Analytics Engine query succeeds, but no destinations are configured
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: events }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      ANALYTICS_FORWARD_ENABLED: 'true',
      // No SEGMENT_WRITE_KEY or GA4 credentials
    });
    const result = await runAnalyticsForward(env);

    expect(result.eventsQueried).toBe(1);
    expect(result.segment.sent).toBe(0);
    expect(result.ga4.sent).toBe(0);
    expect(result.cursorUpdated).toBe(false);
    expect(env.KV.put).not.toHaveBeenCalled();
  });

  it('uses custom event list from ANALYTICS_FORWARD_EVENTS', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      ANALYTICS_FORWARD_ENABLED: 'true',
      ANALYTICS_FORWARD_EVENTS: 'custom_event, another_event',
    });
    await runAnalyticsForward(env);

    const sql = mockFetch.mock.calls[0][1].body;
    expect(sql).toContain("'custom_event'");
    expect(sql).toContain("'another_event'");
    expect(sql).not.toContain("'signup'");
  });

  it('does not advance cursor when one enabled destination fails (partial failure)', async () => {
    const events = [makeEvent()];

    // First call: Analytics Engine query; second call: Segment succeeds; third: GA4 fails
    const mockFetch = vi.fn()
      .mockResolvedValueOnce({
        ok: true,
        json: () => Promise.resolve({ data: events }),
      })
      .mockResolvedValueOnce({ ok: true }) // Segment succeeds
      .mockResolvedValueOnce({
        ok: false,
        status: 500,
        text: () => Promise.resolve('GA4 error'),
      }); // GA4 fails
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      ANALYTICS_FORWARD_ENABLED: 'true',
      SEGMENT_WRITE_KEY: 'test-key',
      GA4_MEASUREMENT_ID: 'G-123',
      GA4_API_SECRET: 'secret',
    });
    const result = await runAnalyticsForward(env);

    expect(result.segment.sent).toBe(1);
    expect(result.ga4.error).toBeDefined();
    expect(result.cursorUpdated).toBe(false);
    expect(env.KV.put).not.toHaveBeenCalled();
  });

  it('uses custom cursor key from ANALYTICS_FORWARD_CURSOR_KEY', async () => {
    const mockFetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      json: () => Promise.resolve({ data: [] }),
    });
    vi.stubGlobal('fetch', mockFetch);

    const env = makeEnv({
      ANALYTICS_FORWARD_ENABLED: 'true',
      ANALYTICS_FORWARD_CURSOR_KEY: 'my-custom-key',
    });
    await runAnalyticsForward(env);

    expect(env.KV.get).toHaveBeenCalledWith('my-custom-key');
  });
});

// ---------------------------------------------------------------------------
// getForwardStatus
// ---------------------------------------------------------------------------

describe('getForwardStatus', () => {
  it('returns disabled status when forwarding is not enabled', async () => {
    const env = makeEnv();
    const status = await getForwardStatus(env);

    expect(status.enabled).toBe(false);
    expect(status.lastForwardedAt).toBeNull();
    expect(status.destinations.segment.configured).toBe(false);
    expect(status.destinations.ga4.configured).toBe(false);
    expect(status.events).toContain('signup');
  });

  it('returns configured destinations', async () => {
    const env = makeEnv({
      ANALYTICS_FORWARD_ENABLED: 'true',
      SEGMENT_WRITE_KEY: 'test-key',
      GA4_MEASUREMENT_ID: 'G-123',
      GA4_API_SECRET: 'secret',
    });
    const status = await getForwardStatus(env);

    expect(status.enabled).toBe(true);
    expect(status.destinations.segment.configured).toBe(true);
    expect(status.destinations.ga4.configured).toBe(true);
  });

  it('reads last forwarded timestamp from KV', async () => {
    const env = makeEnv({
      KV: {
        get: vi.fn().mockResolvedValue('2026-03-27T03:00:00Z'),
        put: vi.fn(),
      },
    });
    const status = await getForwardStatus(env);

    expect(status.lastForwardedAt).toBe('2026-03-27T03:00:00Z');
  });

  it('uses custom event list', async () => {
    const env = makeEnv({
      ANALYTICS_FORWARD_EVENTS: 'custom_a, custom_b',
    });
    const status = await getForwardStatus(env);

    expect(status.events).toEqual(['custom_a', 'custom_b']);
  });
});
