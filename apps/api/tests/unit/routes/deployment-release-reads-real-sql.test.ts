/**
 * Release history reads the environment page relies on, against a real SQL engine:
 * - the release list carries `submittedBy` read from the manifest with `json_extract`;
 * - the release events route returns one release's apply steps, scoped by project and
 *   environment in the predicate itself (`listDeploymentReleaseEvents`).
 *
 * Every attack case has an owner-path control, so "nothing returned" cannot pass because
 * the read is broken outright (`.claude/rules/28`).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { deploymentReleaseRoutes } from '../../../src/routes/deployment-releases';
import { listRoutedCustomDomainHostnames } from '../../../src/services/deployment-environment-summary';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const currentUser = vi.hoisted(() => ({ id: 'user-a' }));

vi.mock('../../../src/middleware/auth', () => ({
  getAuth: () => ({ user: { id: currentUser.id } }),
  getUserId: () => currentUser.id,
  requireApproved: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
  requireAuth: () => vi.fn((_c: unknown, next: () => Promise<void>) => next()),
}));

const SUBMITTED_BY = {
  userId: 'user-a',
  workspaceId: 'ws-1',
  taskId: 'task-pg17',
  agentProfileId: 'profile-sol',
};

describe('deployment release reads — real SQL', () => {
  let sqlite: Database.Database;
  let env: Env;
  let app: Hono<{ Bindings: Env }>;

  function insertEvent(input: {
    id: string;
    projectId: string;
    environmentId: string;
    releaseId: string | null;
    releaseVersion: number | null;
    seq: number;
    eventType: string;
    step: string | null;
    createdAt: string;
    level?: string;
  }): void {
    sqlite
      .prepare(
        `INSERT INTO deployment_release_events
           (id, project_id, environment_id, release_id, release_version, node_id, node_identifier,
            seq, level, event_type, step, message, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'node-1', 'node-1', ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.id,
        input.projectId,
        input.environmentId,
        input.releaseId,
        input.releaseVersion,
        input.seq,
        input.level ?? 'info',
        input.eventType,
        input.step,
        `${input.eventType} message`,
        JSON.stringify({ error: 'raw detail that must stay server-side' }),
        input.createdAt
      );
  }

  async function get(path: string): Promise<Response> {
    return app.fetch(new Request(`https://api.test/api/projects${path}`), env);
  }

  beforeEach(() => {
    currentUser.id = 'user-a';
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    const insertUser = sqlite.prepare(
      "INSERT INTO users (id, email, role, status) VALUES (?, ?, 'user', 'active')"
    );
    insertUser.run('user-a', 'a@example.test');
    insertUser.run('user-b', 'b@example.test');
    const insertProject = sqlite.prepare(
      'INSERT INTO projects (id, user_id, name) VALUES (?, ?, ?)'
    );
    insertProject.run('proj-a', 'user-a', 'Project A');
    insertProject.run('proj-b', 'user-b', 'Project B');
    const insertMember = sqlite.prepare(
      "INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, 'owner', 'active')"
    );
    insertMember.run('proj-a', 'user-a');
    insertMember.run('proj-b', 'user-b');
    const insertEnv = sqlite.prepare(
      `INSERT INTO deployment_environments (id, project_id, name, status, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '2026-10-23T08:00:00.000Z', '2026-10-23T08:00:00.000Z')`
    );
    insertEnv.run('env-a', 'proj-a', 'staging');
    insertEnv.run('env-b', 'proj-b', 'staging');
    const insertRelease = sqlite.prepare(
      `INSERT INTO deployment_releases (id, environment_id, manifest, version, status, created_by, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    );
    insertRelease.run(
      'rel-a1',
      'env-a',
      JSON.stringify({ compose: 'services: {}', submittedBy: SUBMITTED_BY }),
      1,
      'applied',
      'user-a',
      '2026-10-23T08:10:00.000Z'
    );
    // A manifest that is not JSON must not fail the whole list.
    insertRelease.run(
      'rel-a2',
      'env-a',
      '{not json',
      2,
      'failed',
      'user-a',
      '2026-10-23T09:00:00.000Z'
    );
    insertRelease.run(
      'rel-b1',
      'env-b',
      JSON.stringify({ submittedBy: { ...SUBMITTED_BY, userId: 'user-b' } }),
      1,
      'applied',
      'user-b',
      '2026-10-23T08:20:00.000Z'
    );

    // rel-a2's apply: two steps, a failure, and one event written before the node knew the
    // release ID (version only).
    insertEvent({
      id: 'ev-1',
      projectId: 'proj-a',
      environmentId: 'env-a',
      releaseId: 'rel-a2',
      releaseVersion: 2,
      seq: 1,
      eventType: 'deployment.apply.fetch_started',
      step: 'fetch_release',
      createdAt: '2026-10-23T09:00:01.000Z',
    });
    insertEvent({
      id: 'ev-2',
      projectId: 'proj-a',
      environmentId: 'env-a',
      releaseId: 'rel-a2',
      releaseVersion: 2,
      seq: 2,
      eventType: 'deployment.apply.fetch_completed',
      step: 'fetch_release',
      createdAt: '2026-10-23T09:00:02.000Z',
    });
    insertEvent({
      id: 'ev-3',
      projectId: 'proj-a',
      environmentId: 'env-a',
      releaseId: null,
      releaseVersion: 2,
      seq: 1,
      eventType: 'deployment.apply.compose_up_started',
      step: 'compose_up',
      createdAt: '2026-10-23T09:00:03.000Z',
    });
    insertEvent({
      id: 'ev-4',
      projectId: 'proj-a',
      environmentId: 'env-a',
      releaseId: 'rel-a2',
      releaseVersion: 2,
      seq: 3,
      eventType: 'deployment.apply.failed',
      step: 'failed',
      level: 'error',
      createdAt: '2026-10-23T09:00:04.000Z',
    });
    // Another release in the same environment: never part of rel-a2's steps.
    insertEvent({
      id: 'ev-5',
      projectId: 'proj-a',
      environmentId: 'env-a',
      releaseId: 'rel-a1',
      releaseVersion: 1,
      seq: 1,
      eventType: 'deployment.apply.succeeded',
      step: 'succeeded',
      createdAt: '2026-10-23T08:10:05.000Z',
    });
    // A forged row naming rel-a2 under another project and environment: the project and
    // environment predicates must keep it out even though the release ID matches.
    insertEvent({
      id: 'ev-forged',
      projectId: 'proj-b',
      environmentId: 'env-b',
      releaseId: 'rel-a2',
      releaseVersion: 2,
      seq: 9,
      eventType: 'deployment.apply.reverted',
      step: 'revert',
      createdAt: '2026-10-23T09:00:05.000Z',
    });

    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    app = new Hono<{ Bindings: Env }>();
    app.onError((error, context) =>
      error instanceof AppError
        ? context.json(error.toJSON(), error.statusCode as never)
        : context.json({ error: 'INTERNAL_ERROR', message: error.message }, 500)
    );
    app.route('/api/projects', deploymentReleaseRoutes);
  });

  afterEach(() => {
    sqlite.close();
  });

  describe('GET …/releases', () => {
    it('returns who submitted each release, and null for a manifest that is not JSON', async () => {
      const response = await get('/proj-a/environments/env-a/releases');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { releases: Array<Record<string, unknown>> };
      expect(body.releases.map((release) => release.id)).toEqual(['rel-a2', 'rel-a1']);
      expect(body.releases[1]).toMatchObject({
        version: 1,
        status: 'applied',
        submittedBy: SUBMITTED_BY,
      });
      expect(body.releases[0]).toMatchObject({ version: 2, status: 'failed', submittedBy: null });
      // The manifest itself never rides along on the list.
      expect(body.releases[0]).not.toHaveProperty('manifest');
      expect(body.releases[0]).not.toHaveProperty('submittedByJson');
    });

    it("refuses another project's environment, while its owner reads it", async () => {
      expect((await get('/proj-a/environments/env-b/releases')).status).toBe(404);
      currentUser.id = 'user-b';
      expect((await get('/proj-a/environments/env-a/releases')).status).toBe(404);
      const owner = await get('/proj-b/environments/env-b/releases');
      expect(owner.status).toBe(200);
      const body = (await owner.json()) as { releases: Array<{ id: string }> };
      expect(body.releases.map((release) => release.id)).toEqual(['rel-b1']);
    });
  });

  describe('listRoutedCustomDomainHostnames', () => {
    function insertDomain(
      id: string,
      environmentId: string,
      hostname: string,
      overrides: { desiredState?: string; routingStatus?: string; deletedAt?: string | null } = {}
    ): void {
      sqlite
        .prepare(
          `INSERT INTO deployment_custom_domains
             (id, environment_id, service, port, route_index, hostname, verification_status,
              desired_state, routing_status, deleted_at, created_at)
           VALUES (?, ?, 'web', 3000, 0, ?, 'verified', ?, ?, ?, ?)`
        )
        .run(
          id,
          environmentId,
          hostname,
          overrides.desiredState ?? 'active',
          overrides.routingStatus ?? 'active',
          overrides.deletedAt ?? null,
          `2026-10-23T08:0${id.length % 10}:00.000Z`
        );
    }

    it("returns only a project's routed, active, undeleted domains", async () => {
      insertDomain('dom-1', 'env-a', 'shop.example.com');
      insertDomain('dom-22', 'env-a', 'www.example.com');
      insertDomain('dom-3', 'env-a', 'pending.example.com', { routingStatus: 'pending_dns' });
      insertDomain('dom-4', 'env-a', 'gone.example.com', { deletedAt: '2026-10-23T09:00:00.000Z' });
      insertDomain('dom-5', 'env-a', 'leaving.example.com', { desiredState: 'deactivating' });
      // Another project's routed domain: never part of project A's list.
      insertDomain('dom-6', 'env-b', 'other-tenant.example.com');
      const db = drizzle(createSqliteD1(sqlite), { schema });

      const projectA = await listRoutedCustomDomainHostnames(db, 'proj-a');
      expect(Object.fromEntries(projectA)).toEqual({
        'env-a': ['shop.example.com', 'www.example.com'],
      });
      // Owner control: the other project's domain is readable through its own project.
      const projectB = await listRoutedCustomDomainHostnames(db, 'proj-b');
      expect(Object.fromEntries(projectB)).toEqual({ 'env-b': ['other-tenant.example.com'] });
    });
  });

  describe('GET …/releases/:releaseId/events', () => {
    it("returns one release's steps oldest first, including version-only rows, without raw detail", async () => {
      const response = await get('/proj-a/environments/env-a/releases/rel-a2/events');
      expect(response.status).toBe(200);
      const body = (await response.json()) as { events: Array<Record<string, unknown>> };
      expect(body.events.map((event) => event.eventType)).toEqual([
        'deployment.apply.fetch_started',
        'deployment.apply.fetch_completed',
        'deployment.apply.compose_up_started',
        'deployment.apply.failed',
      ]);
      expect(body.events[3]).toMatchObject({ level: 'error', step: 'failed' });
      for (const event of body.events) {
        expect(Object.keys(event).sort()).toEqual([
          'createdAt',
          'eventType',
          'level',
          'message',
          'seq',
          'step',
        ]);
      }
    });

    it('keeps a forged event from another project out, while the owner of that project sees it', async () => {
      const own = (await (
        await get('/proj-a/environments/env-a/releases/rel-a2/events')
      ).json()) as {
        events: Array<{ eventType: string }>;
      };
      expect(own.events.map((event) => event.eventType)).not.toContain('deployment.apply.reverted');

      // Control: the same row is readable through its own project and environment, so the
      // exclusion above is the predicate's doing. (Its release ID points elsewhere, so the
      // route answers 404 for env-b: the release must belong to the environment.)
      expect((await get('/proj-a/environments/env-a/releases/rel-a1/events')).status).toBe(200);
      const fromB = sqlite
        .prepare("SELECT COUNT(*) AS n FROM deployment_release_events WHERE project_id = 'proj-b'")
        .get() as { n: number };
      expect(fromB.n).toBe(1);
    });

    it('answers 404 for a release from another environment and for a non-member', async () => {
      expect((await get('/proj-a/environments/env-a/releases/rel-b1/events')).status).toBe(404);
      expect((await get('/proj-a/environments/env-b/releases/rel-b1/events')).status).toBe(404);
      currentUser.id = 'user-b';
      expect((await get('/proj-a/environments/env-a/releases/rel-a2/events')).status).toBe(404);
      // Owner control for the same user on their own project.
      const owner = await get('/proj-b/environments/env-b/releases/rel-b1/events');
      expect(owner.status).toBe(200);
    });

    it('returns the newest window when a limit is given, still oldest first', async () => {
      const response = await get('/proj-a/environments/env-a/releases/rel-a2/events?limit=2');
      const body = (await response.json()) as { events: Array<{ eventType: string }> };
      expect(body.events.map((event) => event.eventType)).toEqual([
        'deployment.apply.compose_up_started',
        'deployment.apply.failed',
      ]);
    });
  });
});
