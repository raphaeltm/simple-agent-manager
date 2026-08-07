import Database from 'better-sqlite3';
import type { Context, Next } from 'hono';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import diagnosticMigrationSql from '../../../src/db/migrations/0106_diagnostic_incidents.sql?raw';
import observabilityInitSql from '../../../src/db/migrations/observability/0000_init.sql?raw';
import observabilityCorrelationSql from '../../../src/db/migrations/observability/0001_task_session_ids.sql?raw';
import type { Env } from '../../../src/env';
import { handleAppError } from '../../../src/middleware/app-error-handler';
import { createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/middleware/auth', async () => {
  const actual = await vi.importActual<typeof import('../../../src/middleware/auth')>(
    '../../../src/middleware/auth'
  );
  return {
    ...actual,
    requireAuth: () => async (c: Context, next: Next) => {
      const role = c.req.header('x-test-role') === 'user' ? 'user' : 'superadmin';
      c.set('auth', {
        user: {
          id: 'test-user',
          email: 'test@example.com',
          name: 'Test User',
          avatarUrl: null,
          role,
          status: 'active',
        },
        session: { id: 'session-1', expiresAt: new Date('2099-01-01T00:00:00.000Z') },
      });
      await next();
    },
    requireApproved: () => async (_c: Context, next: Next) => next(),
  };
});

vi.mock('../../../src/middleware/rate-limit', () => ({
  rateLimit: () => async (_c: Context, next: Next) => next(),
}));

const { adminRoutes } = await import('../../../src/routes/admin');

describe('admin observability vertical slices', () => {
  let main: Database.Database;
  let observability: Database.Database;
  let app: Hono<{ Bindings: Env }>;

  beforeEach(() => {
    main = new Database(':memory:');
    main.exec(diagnosticMigrationSql);
    observability = new Database(':memory:');
    observability.exec(observabilityInitSql);
    observability.exec(observabilityCorrelationSql);
    app = new Hono<{ Bindings: Env }>();
    app.onError(handleAppError);
    app.route('/api/admin', adminRoutes);
  });

  afterEach(() => {
    main.close();
    observability.close();
  });

  function bindings(): Env {
    return {
      DATABASE: createSqliteD1(main),
      OBSERVABILITY_DATABASE: createSqliteD1(observability),
    } as Env;
  }

  it('queries exact correlation filters through the route and real migrated D1 service', async () => {
    const timestamp = Date.UTC(2026, 7, 7, 12, 0, 0);
    const insert = observability.prepare(`
      INSERT INTO platform_errors
        (id, source, level, message, user_id, node_id, workspace_id, task_id, session_id,
         timestamp, created_at)
      VALUES (?, 'api', 'error', ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    insert.run(
      'target-error',
      'target',
      'user-1',
      'node-1',
      'workspace-1',
      'task-1',
      'session-1',
      timestamp,
      timestamp
    );
    insert.run(
      'other-error',
      'other',
      'user-2',
      'node-2',
      'workspace-2',
      'task-2',
      'session-2',
      timestamp - 1,
      timestamp - 1
    );

    const response = await app.request(
      `/api/admin/observability/errors?nodeId=node-1&workspaceId=workspace-1&taskId=task-1&sessionId=session-1&userId=user-1&endTime=${timestamp}`,
      {},
      bindings()
    );

    expect(response.status).toBe(200);
    const body = await response.json();
    expect(body.errors).toHaveLength(1);
    expect(body.errors[0]).toMatchObject({
      id: 'target-error',
      nodeId: 'node-1',
      workspaceId: 'workspace-1',
      taskId: 'task-1',
      sessionId: 'session-1',
      userId: 'user-1',
    });
  });

  it('returns post-mortem incident artifacts through the route and real D1 service', async () => {
    main
      .prepare(
        `INSERT INTO diagnostic_incidents
          (id, platform_error_id, node_id, workspace_id, status, artifact_count, total_bytes,
           expires_at, delete_after)
         VALUES (?, ?, ?, ?, 'available', 1, 128, ?, ?)`
      )
      .run(
        'incident-1',
        'error-1',
        'dead-node',
        'workspace-1',
        '2099-01-01T00:00:00.000Z',
        '2099-02-01T00:00:00.000Z'
      );
    main
      .prepare(
        `INSERT INTO diagnostic_artifacts
          (id, incident_id, node_id, kind, status, object_key, content_type, expected_bytes,
           actual_bytes, expires_at)
         VALUES (?, ?, ?, 'safe-vm-incident-v1', 'available', ?, 'application/gzip', 128, 128, ?)`
      )
      .run(
        'artifact-1',
        'incident-1',
        'dead-node',
        'vm-incidents/dead-node/incident-1/artifact-1.tar.gz',
        '2099-01-01T00:00:00.000Z'
      );

    const response = await app.request(
      '/api/admin/observability/nodes/dead-node/incidents',
      {},
      bindings()
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toMatchObject({
      incidents: [
        {
          id: 'incident-1',
          nodeId: 'dead-node',
          status: 'available',
          artifacts: [{ id: 'artifact-1', status: 'available' }],
        },
      ],
    });
  });

  it('uses the real superadmin role check to reject both node routes', async () => {
    const request = { headers: { 'x-test-role': 'user' } };
    const [nodes, incidents] = await Promise.all([
      app.request('/api/admin/observability/nodes', request, bindings()),
      app.request('/api/admin/observability/nodes/dead-node/incidents', request, bindings()),
    ]);
    expect(nodes.status).toBe(403);
    expect(incidents.status).toBe(403);
  });
});
