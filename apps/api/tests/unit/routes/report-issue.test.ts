import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { reportIssueRoutes } from '../../../src/routes/report-issue';
import { submitReport } from '../../../src/services/report-issue';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () =>
    vi.fn((c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', {
        user: {
          id: 'user-1',
          email: 'user@example.com',
          name: 'Test User',
          avatarUrl: null,
          role: 'user',
          status: 'active',
        },
        session: {
          id: 'session-1',
          expiresAt: new Date(Date.now() + 60_000),
        },
      });
      return next();
    }),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getUserId: () => 'user-1',
}));

vi.mock('../../../src/services/report-issue', () => ({
  isReportEnabled: vi.fn(async () => true),
  submitReport: vi.fn(async () => ({
    ideaId: 'idea-1',
    status: 'draft',
    refsAttached: false,
    attachedRefKeys: [],
    message: 'Report submitted without technical references.',
  })),
}));

function createMemoryKv(initial: Record<string, unknown> = {}): Pick<KVNamespace, 'get' | 'put'> {
  const entries = new Map<string, string>();
  for (const [key, value] of Object.entries(initial)) {
    entries.set(key, JSON.stringify(value));
  }

  return {
    get: vi.fn(async (key: string, type?: string) => {
      const entry = entries.get(key);
      if (!entry) return null;
      return type === 'json' ? JSON.parse(entry) : entry;
    }),
    put: vi.fn(async (key: string, value: string) => {
      entries.set(key, value);
    }),
  };
}

function currentHourWindowStart(): number {
  return Math.floor(Date.now() / 1000 / 3600) * 3600;
}

function createEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: {} as D1Database,
    KV: createMemoryKv() as KVNamespace,
    PLATFORM_FEEDBACK_PROJECT_ID: 'feedback-project-1',
    ...overrides,
  } as Env;
}

function createTestApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((err, c) => {
    if (err instanceof AppError) {
      return c.json(err.toJSON(), err.statusCode as 429);
    }
    throw err;
  });
  app.route('/api/report-issue', reportIssueRoutes);
  return app;
}

async function postReport(app: Hono<{ Bindings: Env }>, env: Env) {
  return app.request(
    '/api/report-issue',
    {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        title: 'Bug report',
        description: 'Something broke',
        consentToAttachRefs: false,
      }),
    },
    env
  );
}

describe('POST /api/report-issue rate limiting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('sets project-standard rate-limit headers on allowed submissions', async () => {
    const env = createEnv({ RATE_LIMIT_REPORT_ISSUE_POST: '2' });
    const app = createTestApp();

    const res = await postReport(app, env);

    expect(res.status).toBe(201);
    expect(res.headers.get('X-RateLimit-Limit')).toBe('2');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('1');
    expect(Number(res.headers.get('X-RateLimit-Reset'))).toBeGreaterThan(0);
    expect(submitReport).toHaveBeenCalledTimes(1);
  });

  it('returns standard RATE_LIMIT_EXCEEDED 429 and skips Idea creation when exhausted', async () => {
    const windowStart = currentHourWindowStart();
    const env = createEnv({
      RATE_LIMIT_REPORT_ISSUE_POST: '1',
      KV: createMemoryKv({
        [`ratelimit:report-issue-post:user-1:${windowStart}`]: {
          count: 1,
          windowStart,
        },
      }) as KVNamespace,
    });
    const app = createTestApp();

    const res = await postReport(app, env);

    expect(res.status).toBe(429);
    expect(res.headers.get('Retry-After')).toBeTruthy();
    expect(res.headers.get('X-RateLimit-Limit')).toBe('1');
    expect(res.headers.get('X-RateLimit-Remaining')).toBe('0');
    await expect(res.json()).resolves.toMatchObject({
      error: 'RATE_LIMIT_EXCEEDED',
      message: 'Too many requests. Please try again later.',
    });
    expect(submitReport).not.toHaveBeenCalled();
  });
});
