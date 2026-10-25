/**
 * Pause/resume column updates, as a pure function and through the real REST PATCH route on a
 * real SQLite database (only authentication, project authorization and attribution health are
 * stubbed), so the route is proven to use the shared computation.
 */
import Database from 'better-sqlite3';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { cronToNextFire } from '../../../src/services/cron-utils';
import { triggerStatusUpdates } from '../../../src/services/trigger-status';
import { createAllSchemaTables, createMemoryKv, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', () => ({
  requireAuth: () =>
    vi.fn((c: { set: (key: string, value: unknown) => void }, next: () => Promise<void>) => {
      c.set('auth', { user: { id: 'user-1', name: 'Owner', email: 'owner@example.com' } });
      return next();
    }),
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  getAuth: (c: { get: (key: string) => unknown }) => c.get('auth'),
  getUserId: () => 'user-1',
}));
vi.mock('../../../src/middleware/project-auth', () => ({
  requireProjectCapability: vi.fn().mockResolvedValue({
    id: 'project-1',
    userId: 'user-1',
    name: 'Payments API',
    repository: 'acme/payments',
    maxTriggers: null,
  }),
}));
vi.mock('../../../src/services/project-multiplayer', () => ({
  getProjectMultiplayerState: vi.fn().mockResolvedValue({ multiplayerActive: false }),
  clearProjectMultiplayerStateCache: vi.fn(),
}));
vi.mock('../../../src/services/credential-attribution-health', () => ({
  buildCredentialAttributionForTriggers: vi.fn().mockResolvedValue(new Map()),
  clearCredentialAttributionHealthCache: vi.fn(),
}));

const { triggersRoutes } = await import('../../../src/routes/triggers');

const NOW = new Date('2026-10-20T10:07:00.000Z');
const cron = {
  status: 'paused',
  sourceType: 'cron',
  cronExpression: '0 9 * * 1-5',
  cronTimezone: 'Europe/Paris',
};

describe('triggerStatusUpdates', () => {
  it('pausing or disabling clears the next fire and leaves the failure window alone', () => {
    for (const status of ['paused', 'disabled'] as const) {
      const updates = triggerStatusUpdates({ ...cron, status: 'active' }, status, NOW);
      expect(updates).toEqual({ status, nextFireAt: null });
      expect(updates).not.toHaveProperty('autoPauseResetSequence');
    }
  });

  it('resuming a paused cron trigger restarts the failure window and schedules the next fire', () => {
    const updates = triggerStatusUpdates(cron, 'active', NOW);
    expect(updates.status).toBe('active');
    expect(updates.autoPauseResetSequence).toBeDefined();
    // 09:00 Paris on the next weekday after Tuesday 12:07 Paris time.
    expect(updates.nextFireAt).toBe('2026-10-21T07:00:00.000Z');
    expect(updates.nextFireAt).toBe(cronToNextFire(cron.cronExpression, cron.cronTimezone, NOW));
  });

  it('computes the next fire from the schedule it is given, not the stored one', () => {
    const updates = triggerStatusUpdates(
      { ...cron, cronExpression: '30 18 * * *', cronTimezone: 'America/New_York' },
      'active',
      NOW
    );
    expect(updates.nextFireAt).toBe('2026-10-20T22:30:00.000Z');
  });

  it('keeps the failure window of a trigger that was already active', () => {
    const updates = triggerStatusUpdates({ ...cron, status: 'active' }, 'active', NOW);
    expect(updates).not.toHaveProperty('autoPauseResetSequence');
    expect(updates.nextFireAt).toBe('2026-10-21T07:00:00.000Z');
  });

  it('does not compute a next fire for a non-cron trigger or a cron row without an expression', () => {
    const webhook = triggerStatusUpdates(
      { status: 'paused', sourceType: 'webhook', cronExpression: null, cronTimezone: null },
      'active',
      NOW
    );
    expect(webhook.autoPauseResetSequence).toBeDefined();
    expect(webhook).not.toHaveProperty('nextFireAt');
    expect(
      triggerStatusUpdates({ ...cron, cronExpression: null }, 'active', NOW)
    ).not.toHaveProperty('nextFireAt');
  });
});

describe('PATCH /triggers/:id status through the real route', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ['Date'], now: NOW });
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`INSERT INTO users (id, email, name, role, status) VALUES ('user-1', 'owner@example.com', 'Owner', 'user', 'active');
      INSERT INTO projects (id, user_id, name) VALUES ('project-1', 'user-1', 'Payments API');`);
    const insert =
      sqlite.prepare(`INSERT INTO triggers (id, project_id, user_id, name, status, source_type,
      cron_expression, cron_timezone, skip_if_running, prompt_template, task_mode, max_concurrent,
      trigger_count, next_execution_sequence, auto_pause_reset_sequence, next_fire_at, created_at, updated_at)
      VALUES (?, 'project-1', 'user-1', ?, ?, ?, ?, ?, 1, 'Review', 'task', 1, 3, 7, NULL, ?, '2026-10-01T00:00:00Z', '2026-10-01T00:00:00Z')`);
    insert.run(
      'cron-1',
      'Nightly',
      'active',
      'cron',
      '0 9 * * 1-5',
      'Europe/Paris',
      '2026-10-20T07:00:00.000Z'
    );
    insert.run('hook-1', 'Hook', 'paused', 'webhook', null, null, null);
    env = {
      DATABASE: createSqliteD1(sqlite),
      KV: createMemoryKv(),
      BASE_DOMAIN: 'example.com',
    } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/projects/:projectId/triggers', triggersRoutes);
  });

  afterEach(() => {
    vi.useRealTimers();
    sqlite.close();
  });

  const patch = (triggerId: string, body: unknown) =>
    app.request(
      `/api/projects/project-1/triggers/${triggerId}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
      },
      env
    );
  const row = (triggerId: string) =>
    sqlite
      .prepare('SELECT status, next_fire_at, auto_pause_reset_sequence FROM triggers WHERE id = ?')
      .get(triggerId);

  it('pauses, then resumes with a fresh next fire and a restarted failure window', async () => {
    expect((await patch('cron-1', { status: 'paused' })).status).toBe(200);
    expect(row('cron-1')).toEqual({
      status: 'paused',
      next_fire_at: null,
      auto_pause_reset_sequence: null,
    });

    expect((await patch('cron-1', { status: 'active' })).status).toBe(200);
    expect(row('cron-1')).toEqual({
      status: 'active',
      next_fire_at: '2026-10-21T07:00:00.000Z',
      auto_pause_reset_sequence: 7,
    });
  });

  it('resumes a webhook trigger without inventing a next fire', async () => {
    expect((await patch('hook-1', { status: 'active' })).status).toBe(200);
    expect(row('hook-1')).toEqual({
      status: 'active',
      next_fire_at: null,
      auto_pause_reset_sequence: 7,
    });
  });

  it('takes the next fire from the new cron when one request changes it and resumes', async () => {
    expect((await patch('cron-1', { status: 'paused' })).status).toBe(200);
    // Weekdays 09:00 Paris becomes 06:30 UTC every day.
    const response = await patch('cron-1', {
      status: 'active',
      cronExpression: '30 6 * * *',
      cronTimezone: 'UTC',
    });
    expect(response.status).toBe(200);
    expect(row('cron-1')).toMatchObject({
      status: 'active',
      next_fire_at: cronToNextFire('30 6 * * *', 'UTC'),
    });
  });
});
