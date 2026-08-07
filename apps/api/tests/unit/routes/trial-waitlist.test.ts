/**
 * Behavioral tests for POST /api/trial/waitlist.
 *
 * Verifies:
 *   - Valid email → 200 { queued: true, resetsAt }
 *   - Invalid email → 400 BAD_REQUEST
 *   - Non-JSON body → 400 BAD_REQUEST
 *   - Email is lowercased before insert (case-insensitive dedupe)
 *   - Uses onConflictDoNothing on (email, resetDate) for idempotent re-submits
 *   - D1 error → 500 INTERNAL_ERROR
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';

vi.mock('../../../src/lib/logger', () => ({
  log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() },
}));

const { insertMock, valuesMock, onConflictMock } = vi.hoisted(() => {
  const onConflictMock = vi.fn().mockResolvedValue(undefined);
  const valuesMock = vi
    .fn()
    .mockReturnValue({ onConflictDoNothing: onConflictMock });
  const insertMock = vi.fn().mockReturnValue({ values: valuesMock });
  return { insertMock, valuesMock, onConflictMock };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: insertMock,
  }),
}));

vi.mock('../../../src/db/schema', () => ({
  trialWaitlist: {
    email: 'email',
    resetDate: 'reset_date',
  },
}));

const { waitlistRoutes } = await import('../../../src/routes/trial/waitlist');

function makeApp() {
  const app = new Hono<{ Bindings: Env }>();
  app.route('/api/trial', waitlistRoutes);
  const env = { DATABASE: {} } as unknown as Env;
  return { app, env };
}

async function post(app: Hono<{ Bindings: Env }>, env: Env, body: unknown) {
  return app.fetch(
    new Request('https://api.test/api/trial/waitlist', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: typeof body === 'string' ? body : JSON.stringify(body),
    }),
    env
  );
}

describe('POST /api/trial/waitlist', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    onConflictMock.mockResolvedValue(undefined);
  });

  it('queues a valid email and returns resetsAt', async () => {
    const { app, env } = makeApp();
    const res = await post(app, env, { email: 'alice@example.com' });
    expect(res.status).toBe(200);
    const body = (await res.json()) as { queued: boolean; resetsAt: string };
    expect(body.queued).toBe(true);
    expect(body.resetsAt).toMatch(/^\d{4}-\d{2}-01$/);
  });

  it('lowercases the email before insert (case-insensitive dedupe)', async () => {
    const { app, env } = makeApp();
    await post(app, env, { email: 'ALICE@Example.COM' });
    expect(valuesMock).toHaveBeenCalledWith(
      expect.objectContaining({ email: 'alice@example.com' })
    );
  });

  it('uses onConflictDoNothing on (email, resetDate) for idempotency', async () => {
    const { app, env } = makeApp();
    await post(app, env, { email: 'bob@example.com' });
    expect(onConflictMock).toHaveBeenCalledWith(
      expect.objectContaining({
        target: expect.arrayContaining(['email', 'reset_date']),
      })
    );
  });

  it('rejects invalid email with 400', async () => {
    const { app, env } = makeApp();
    const res = await post(app, env, { email: 'not-an-email' });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('BAD_REQUEST');
  });

  it('rejects non-JSON body with 400', async () => {
    const { app, env } = makeApp();
    const res = await post(app, env, 'not json at all');
    expect(res.status).toBe(400);
  });

  it('returns 500 when D1 insert fails', async () => {
    onConflictMock.mockRejectedValue(new Error('D1 exploded'));
    const { app, env } = makeApp();
    const res = await post(app, env, { email: 'alice@example.com' });
    expect(res.status).toBe(500);
    const body = (await res.json()) as { error: string };
    expect(body.error).toBe('INTERNAL_ERROR');
  });
});
