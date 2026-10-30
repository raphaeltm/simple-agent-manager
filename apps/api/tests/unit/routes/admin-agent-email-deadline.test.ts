import { Hono } from 'hono';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { adminAgentEmailRoutes } from '../../../src/routes/admin-agent-email';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';

const lookup = vi.hoisted(() => vi.fn());
vi.mock('../../../src/auth', () => ({ createAuth: async () => ({ api: { getSession: lookup } }) }));
afterEach(() => {
  vi.useRealTimers();
  vi.clearAllMocks();
});

describe('agent email GET deadlines include the authentication middleware', () => {
  it.each([
    ['', 100],
    ['/setup', 200],
  ] as const)('bounds %s when session lookup never returns', async (suffix, deadlineMs) => {
    const { sqlite, env } = createAdminSettingsEnv({ BASE_DOMAIN: 'fixture.example' });
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
      .run('agentEmail.readTimeoutMs', '100', '2026-10-30');
    sqlite
      .prepare('INSERT INTO platform_settings(key,value,updated_at) VALUES(?,?,?)')
      .run('agentEmail.setupPlanTimeoutMs', '200', '2026-10-30');
    const app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/admin/agent-email', adminAgentEmailRoutes);
    lookup.mockImplementation(() => new Promise(() => {}));
    vi.useFakeTimers();
    try {
      const pending = app.request(`/api/admin/agent-email${suffix}`, {}, env);
      await vi.advanceTimersByTimeAsync(deadlineMs - 1);
      expect(lookup).toHaveBeenCalledTimes(1);
      await vi.advanceTimersByTimeAsync(1);
      const response = await pending;
      expect(response.status).toBe(504);
      expect(await response.json()).toMatchObject({ error: 'AGENT_EMAIL_TIMEOUT' });
    } finally {
      sqlite.close();
    }
  });
});
