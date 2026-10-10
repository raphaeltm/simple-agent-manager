/**
 * Real D1 plus the real workspace eviction callback route, for recovery vertical slices.
 * Test files own their module mocks (callback JWT, ProjectData, TaskRunner start); those
 * apply to the modules imported here too.
 */
import type Database from 'better-sqlite3';
import { Hono } from 'hono';

import type { Env } from '../../src/env';
import { AppError } from '../../src/middleware/error';
import { workspaceEvictionCallbackRoute } from '../../src/routes/projects/workspace-eviction-callback';
import { finalizeWorkspaceEvictionInNode } from '../../src/services/workspace-eviction-lifecycle';
import { createSqliteD1 } from './sqlite-d1';

/** The owner, their cloud credential, the project and the VM node an evicted workspace ran on. */
export function seedEvictionOwnerAndNode(sqlite: Database.Database): void {
  sqlite.exec(`
    INSERT INTO users (id, name, email, github_id, status)
    VALUES ('user-1', 'Test User', 'test@example.com', 'gh-1', 'active');

    INSERT INTO credentials
      (id, user_id, provider, credential_type, credential_kind, is_active,
       encrypted_token, iv, created_at, updated_at)
    VALUES ('credential-1', 'user-1', 'hetzner', 'cloud-provider', 'api-key', 1,
      'encrypted', 'iv', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

    INSERT INTO projects
      (id, user_id, name, normalized_name, repository, installation_id, default_branch,
       default_location, created_by, created_at, updated_at)
    VALUES ('project-1', 'user-1', 'Project', 'project', 'owner/repo', 'install-1',
      'main', 'hel1', 'user-1', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);

    INSERT INTO project_members (project_id, user_id, role, status)
    VALUES ('project-1', 'user-1', 'owner', 'active');

    INSERT INTO nodes
      (id, user_id, name, status, health_status, runtime, vm_size, vm_location,
       cloud_provider, created_at, updated_at)
    VALUES ('node-1', 'user-1', 'Node', 'running', 'healthy', 'vm', 'small', 'nbg1',
      'hetzner', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP);
  `);
}

/** An env whose NodeLifecycle stub serializes eviction finalization the way the DO gate does. */
export function createEvictionEnv(sqlite: Database.Database, vars: Partial<Env> = {}): Env {
  let finalizationQueue: Promise<unknown> = Promise.resolve();
  const env = {
    ...vars,
    DATABASE: createSqliteD1(sqlite),
    NODE_LIFECYCLE: {
      idFromName: (id: string) => id,
      get: () => ({
        getWorkspaceDeletionAttemptState: () => Promise.resolve({ pending: false }),
        finalizeWorkspaceEviction: (
          identity: Parameters<typeof finalizeWorkspaceEvictionInNode>[1]
        ) => {
          const result = finalizationQueue
            .catch(() => undefined)
            .then(() => finalizeWorkspaceEvictionInNode(env, identity));
          finalizationQueue = result;
          return result;
        },
      }),
    },
  } as unknown as Env;
  return env;
}

export function createEvictionApp(): Hono<{ Bindings: Env }> {
  const app = new Hono<{ Bindings: Env }>();
  app.onError((error, c) =>
    error instanceof AppError
      ? c.json(error.toJSON(), error.statusCode as never)
      : c.json({ error: error.message }, 500)
  );
  app.route('/projects', workspaceEvictionCallbackRoute);
  return app;
}

/** The VM agent's OOM eviction callback for workspace-1 on node-1, generation-1. */
export function postEvictionCallback(app: Hono<{ Bindings: Env }>, env: Env): Promise<Response> {
  return Promise.resolve(
    app.fetch(
      new Request('https://api.test/projects/project-1/workspaces/workspace-1/eviction', {
        method: 'POST',
        headers: { Authorization: 'Bearer token', 'Content-Type': 'application/json' },
        body: JSON.stringify({
          nodeId: 'node-1',
          workspaceId: 'workspace-1',
          reason: 'oom_kill',
          snapshotCaptured: true,
          containerStopped: true,
          evictionGeneration: 'generation-1',
        }),
      }),
      env,
      { waitUntil: () => undefined } as unknown as ExecutionContext
    )
  );
}
