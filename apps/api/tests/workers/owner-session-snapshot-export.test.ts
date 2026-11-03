import { env, runInDurableObject, SELF } from 'cloudflare:test';
import { drizzle } from 'drizzle-orm/d1';
import { beforeAll, describe, expect, it, vi } from 'vitest';

import * as schema from '../../src/db/schema';
import type { ProjectData } from '../../src/durable-objects/project-data';
import type { Env } from '../../src/env';
import { createRequestScopedD1 } from '../../src/lib/d1-session';
import { AppError } from '../../src/middleware/error';
import { ownerSessionSnapshotRoutes } from '../../src/routes/owner-session-snapshots';
import * as projectData from '../../src/services/project-data';
import { buildSessionSnapshotR2Key } from '../../src/services/session-snapshot-artifacts';
import { authenticatedTestApp } from './helpers/authenticated-app';
import { seedInstallation, seedProject, seedSignedInUser, seedUser } from './helpers/seed-d1';

const prefix = `owner-export-${crypto.randomUUID()}`;
const owner = `${prefix}-owner`;
const other = `${prefix}-other`;
const project = `${prefix}-project`;
const foreignProject = `${prefix}-foreign`;
const bindings = env as unknown as Env;
const bytes = new Uint8Array([0, 255, 1, 128, 10, 0, 42]);
const hash = async (data: Uint8Array) =>
  Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256', data)), (b) =>
    b.toString(16).padStart(2, '0')
  ).join('');

function app(user = owner) {
  const testApp = authenticatedTestApp(user);
  testApp.onError((e, c) =>
    e instanceof AppError
      ? c.json(e.toJSON(), e.statusCode as 404)
      : c.json({ error: 'INTERNAL_ERROR', message: 'Internal server error' }, 500)
  );
  testApp.route('/api/projects/:projectId/sessions', ownerSessionSnapshotRoutes);
  return testApp;
}

async function fixture(creator = owner) {
  const session = await projectData.createSession(
    bindings,
    project,
    null,
    'Synthetic retained export',
    null,
    creator
  );
  const id = crypto.randomUUID();
  const generation = crypto.randomUUID();
  const sha256 = await hash(bytes);
  const manifest = JSON.stringify({
    version: 1,
    chatSessionId: session,
    workspaceId: 'deleted-original-workspace',
    status: 'degraded',
    degradation: 'wip-only',
    skipped: [],
    artifacts: { wip: { sizeBytes: bytes.length, sha256 } },
    createdAt: new Date().toISOString(),
  });
  const manifestKey = buildSessionSnapshotR2Key(bindings, session, generation, 'manifest');
  const wipKey = buildSessionSnapshotR2Key(bindings, session, generation, 'wip');
  await env.R2.put(manifestKey, manifest);
  // Deliberately omit R2 sha256: direct/multipart uploads may not expose it.
  await env.R2.put(wipKey, bytes);
  await drizzle(env.DATABASE, { schema })
    .insert(schema.sessionSnapshots)
    .values({
      id,
      userId: creator,
      projectId: project,
      chatSessionId: session,
      runtime: 'vm',
      status: 'degraded',
      degradation: 'wip-only',
      manifestJson: manifest,
      manifestR2Key: manifestKey,
      wipR2Key: wipKey,
      wipSha256: sha256,
      snapshotGeneration: generation,
      expiresAt: new Date(Date.now() + 60_000).toISOString(),
    });
  const url = (artifact = 'wip', p = project) =>
    `https://api.test.example.com/api/projects/${p}/sessions/${session}/retained-snapshot/${artifact}`;
  return { session, id, generation, manifest, manifestKey, wipKey, url };
}

async function update(id: string, fields: Record<string, unknown>) {
  const { eq } = await import('drizzle-orm');
  await drizzle(env.DATABASE, { schema })
    .update(schema.sessionSnapshots)
    .set(fields)
    .where(eq(schema.sessionSnapshots.id, id));
}

async function unavailable(response: Response) {
  expect(response.status).toBe(404);
  expect(await response.json()).toEqual({
    error: 'NOT_FOUND',
    message: 'Retained snapshot not found',
  });
  expect(response.headers.get('cache-control')).toBe('private, no-store');
}

describe('human owner retained snapshot export across route/DO/D1/R2', () => {
  beforeAll(async () => {
    await seedUser(owner);
    await seedUser(other);
    await seedInstallation(`${prefix}-installation`, owner);
    await seedProject(project, owner, `${prefix}-installation`);
    await seedProject(foreignProject, owner, `${prefix}-installation`);
    await env.DATABASE.prepare(
      "INSERT INTO project_members (project_id,user_id,role,status,created_at,updated_at) VALUES (?,?,'admin','active',datetime('now'),datetime('now'))"
    )
      .bind(project, other)
      .run();
  });

  it('downloads exact binary and manifest privately for stopped session without a workspace, without lifecycle writes', async () => {
    const f = await fixture();
    await projectData.stopSession(bindings, project, f.session);
    const before = await projectData.getSession(bindings, project, f.session);
    const response = await app().request(f.url(), {}, bindings);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
    expect(response.headers.get('content-type')).toBe('application/octet-stream');
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="session-.*-wip.bundle"$/
    );
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('location')).toBeNull();
    const manifest = await app().request(f.url('manifest'), {}, bindings);
    expect(manifest.status).toBe(200);
    expect(await manifest.text()).toBe(f.manifest);
    expect(await projectData.getSession(bindings, project, f.session)).toEqual(before);
  });

  it('requires real browser authentication in the full worker and rejects callback bearer tokens', async () => {
    const f = await fixture();
    expect((await SELF.fetch(f.url())).status).toBe(401);
    expect(
      (await SELF.fetch(f.url(), { headers: { authorization: 'Bearer invalid-agent-token' } }))
        .status
    ).toBe(401);
    const cookie = await seedSignedInUser(owner);
    const ok = await SELF.fetch(f.url(), { headers: { cookie } });
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
    await env.DATABASE.prepare("UPDATE users SET status='suspended' WHERE id=?").bind(owner).run();
    expect((await SELF.fetch(f.url(), { headers: { cookie } })).status).toBe(403);
    await env.DATABASE.prepare("UPDATE users SET status='active' WHERE id=?").bind(owner).run();
  });

  it('hides foreign owner, foreign project/session, and missing resources with the same error', async () => {
    const f = await fixture();
    await unavailable(await app(other).request(f.url(), {}, bindings));
    await unavailable(await app().request(f.url('wip', foreignProject), {}, bindings));
    await unavailable(await app().request(f.url().replace(f.session, 'missing'), {}, bindings));
    await unavailable(
      await app().request(f.url().replace(project, 'missing-project'), {}, bindings)
    );
  });

  it('does not let a project owner export another member creator snapshot', async () => {
    const f = await fixture(other);
    await unavailable(await app(owner).request(f.url(), {}, bindings));
    const ok = await app(other).request(f.url(), {}, bindings);
    expect(ok.status).toBe(200);
    await ok.arrayBuffer();
  });

  it.each([
    'userId',
    'projectId',
    'wipR2Key',
    'manifestR2Key',
    'snapshotGeneration',
    'manifestJson',
  ])('rejects mismatched snapshot %s', async (field) => {
    const f = await fixture();
    await update(f.id, {
      [field]: field === 'userId' ? other : field === 'projectId' ? foreignProject : 'foreign',
    });
    await unavailable(await app().request(f.url(), {}, bindings));
  });

  it.each([
    'expired',
    'deleted',
    'missing-wip',
    'corrupt-wip',
    'corrupt-manifest',
    'oversize',
    'wrong-length',
  ])('fails closed for %s', async (scenario) => {
    const f = await fixture();
    if (scenario === 'expired')
      await update(f.id, { expiresAt: new Date(Date.now() - 1).toISOString() });
    if (scenario === 'deleted')
      await env.DATABASE.prepare('DELETE FROM session_snapshots WHERE id=?').bind(f.id).run();
    if (scenario === 'missing-wip') await env.R2.delete(f.wipKey);
    if (scenario === 'corrupt-wip')
      await env.R2.put(f.wipKey, new Uint8Array([1, 255, 1, 128, 10, 0, 42]));
    if (scenario === 'corrupt-manifest') await env.R2.put(f.manifestKey, '{}');
    if (scenario === 'wrong-length') await env.R2.put(f.wipKey, new Uint8Array([1]));
    const e =
      scenario === 'oversize'
        ? { ...bindings, SESSION_SNAPSHOT_TOTAL_BUDGET_BYTES: '1' }
        : bindings;
    await unavailable(
      await app().request(f.url(scenario === 'corrupt-manifest' ? 'manifest' : 'wip'), {}, e)
    );
  });

  it('exports only manifest and wip and rejects supplied snapshot/key selectors', async () => {
    const f = await fixture();
    await unavailable(await app().request(f.url('home'), {}, bindings));
    await unavailable(
      await app().request(f.url() + '?snapshotId=foreign&key=private/home.tar', {}, bindings)
    );
  });

  it.each([
    'expiry',
    'delete',
    'capture-complete',
    'capture-start',
    'owner-change',
    'membership-revoke',
    'object-replace',
  ])('rechecks consistent ownership/generation against %s during R2 retrieval', async (race) => {
    const f = await fixture();
    let changed = false;
    const bucket = new Proxy(env.R2, {
      get(target, prop) {
        if (prop !== 'get') {
          const value = Reflect.get(target, prop);
          return typeof value === 'function' ? value.bind(target) : value;
        }
        return async (...args: Parameters<R2Bucket['get']>) => {
          const object = await target.get(...args);
          if (!changed && args[0] === f.wipKey) {
            changed = true;
            if (race === 'expiry')
              await update(f.id, { expiresAt: new Date(Date.now() - 1).toISOString() });
            if (race === 'delete')
              await env.DATABASE.prepare('DELETE FROM session_snapshots WHERE id=?')
                .bind(f.id)
                .run();
            if (race === 'capture-start') await update(f.id, { captureGeneration: 'new-capture' });
            if (race === 'membership-revoke')
              await env.DATABASE.prepare(
                "UPDATE project_members SET status='suspended' WHERE project_id=? AND user_id=?"
              )
                .bind(project, owner)
                .run();
            if (race === 'capture-complete')
              await update(f.id, { snapshotGeneration: 'new-completed-generation' });
            if (race === 'owner-change') await update(f.id, { userId: other });
            if (race === 'object-replace')
              await target.put(f.wipKey, new Uint8Array([1, 255, 1, 128, 10, 0, 42]));
          }
          return object;
        };
      },
    });
    await unavailable(await app().request(f.url(), {}, { ...bindings, R2: bucket }));
    if (race === 'membership-revoke')
      await env.DATABASE.prepare(
        "UPDATE project_members SET status='active' WHERE project_id=? AND user_id=?"
      )
        .bind(project, owner)
        .run();
  });
  it.each(['R2', 'DO'])('does not log or reflect private %s failure text', async (boundary) => {
    const f = await fixture();
    const privateError = 'Durable object reset PRIVATE_CODE_CANARY';
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const error = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const log = vi.spyOn(console, 'log').mockImplementation(() => undefined);
    try {
      const broken =
        boundary === 'R2'
          ? {
              ...bindings,
              R2: new Proxy(env.R2, {
                get(target, prop) {
                  if (prop === 'get')
                    return () => {
                      throw new Error(privateError);
                    };
                  const value = Reflect.get(target, prop);
                  return typeof value === 'function' ? value.bind(target) : value;
                },
              }),
            }
          : {
              ...bindings,
              PROJECT_DATA: {
                idFromName: env.PROJECT_DATA.idFromName.bind(env.PROJECT_DATA),
                get: () => ({
                  getSession: () => {
                    throw new Error(privateError);
                  },
                }),
              } as unknown as Env['PROJECT_DATA'],
            };
      const response = await app().request(f.url(), {}, broken);
      expect(response.status).toBe(500);
      expect(await response.text()).not.toContain('PRIVATE_CODE_CANARY');
      expect(
        JSON.stringify([...warn.mock.calls, ...error.mock.calls, ...log.mock.calls])
      ).not.toContain('PRIVATE_CODE_CANARY');
    } finally {
      warn.mockRestore();
      error.mockRestore();
      log.mockRestore();
    }
  });
  it('reads archived terminal-session metadata without reading its transcript archive', async () => {
    const f = await fixture();
    await projectData.stopSession(bindings, project, f.session);
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(project)
    ) as DurableObjectStub<ProjectData>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec(
        "UPDATE chat_sessions SET archive_state='published',archive_owner_name='synthetic-archive-owner',archive_generation=1 WHERE id=?",
        f.session
      );
    });
    const response = await app().request(f.url(), {}, bindings);
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('does not consult a stale request-scoped replica for the export ownership fence', async () => {
    const f = await fixture();
    const stale = {
      prepare: () => {
        throw new Error('stale replica must never authorize export');
      },
    };
    const primary = new Proxy(env.DATABASE, {
      get(target, prop) {
        if (prop === 'withSession') return () => stale;
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const requestDatabase = createRequestScopedD1(primary);
    const testApp = authenticatedTestApp(owner);
    testApp.use('*', async (c, next) => {
      c.set('signupApprovalRequired', false);
      await next();
    });
    testApp.route('/api/projects/:projectId/sessions', ownerSessionSnapshotRoutes);
    const response = await testApp.request(f.url(), {}, { ...bindings, DATABASE: requestDatabase });
    expect(response.status).toBe(200);
    expect(new Uint8Array(await response.arrayBuffer())).toEqual(bytes);
  });

  it('requires approved account even when global signup approval is disabled', async () => {
    const f = await fixture();
    const cookie = await seedSignedInUser(owner);
    await env.DATABASE.prepare("UPDATE users SET status='pending' WHERE id=?").bind(owner).run();
    try {
      const testApp = new (await import('hono')).Hono<{ Bindings: Env }>();
      testApp.route('/api/projects/:projectId/sessions', ownerSessionSnapshotRoutes);
      const response = await testApp.request(
        f.url(),
        { headers: { cookie } },
        { ...bindings, REQUIRE_APPROVAL: 'false' }
      );
      expect(response.status).toBe(403);
      expect(response.headers.get('cache-control')).toBe('private, no-store');
    } finally {
      await env.DATABASE.prepare("UPDATE users SET status='active' WHERE id=?").bind(owner).run();
    }
  });

  it('supports authenticated HEAD preflight with private headers and no artifact bytes', async () => {
    const f = await fixture();
    const cookie = await seedSignedInUser(owner);
    const response = await SELF.fetch(f.url(), { method: 'HEAD', headers: { cookie } });
    expect(response.status).toBe(200);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(response.headers.get('content-length')).toBe(String(bytes.length));
    expect(response.headers.get('content-disposition')).toMatch(
      /^attachment; filename="session-.*-wip.bundle"$/
    );
    expect((await response.arrayBuffer()).byteLength).toBe(0);
  });

  it('rejects an owned snapshot row when the canonical session was created by another member', async () => {
    const f = await fixture(other);
    await update(f.id, { userId: owner });
    await unavailable(await app(owner).request(f.url(), {}, bindings));
  });

  it('rejects a retained row whose canonical session no longer exists', async () => {
    const f = await fixture();
    const stub = env.PROJECT_DATA.get(
      env.PROJECT_DATA.idFromName(project)
    ) as DurableObjectStub<ProjectData>;
    await runInDurableObject(stub, async (_instance, state) => {
      state.storage.sql.exec('DELETE FROM chat_sessions WHERE id=?', f.session);
    });
    await unavailable(await app().request(f.url(), {}, bindings));
  });

  it('rejects a missing manifest object despite retained D1 manifest metadata', async () => {
    const f = await fixture();
    await env.R2.delete(f.manifestKey);
    await unavailable(await app().request(f.url('manifest'), {}, bindings));
  });

  it('bounds a stalled verification body and cancels it before returning any bytes', async () => {
    const f = await fixture();
    const cancel = vi.fn();
    const bucket = new Proxy(env.R2, {
      get(target, prop) {
        if (prop === 'get')
          return async (...args: Parameters<R2Bucket['get']>) => {
            const object = await target.get(...args);
            if (!object || !('body' in object)) return object;
            void object.body.cancel();
            return new Proxy(object, {
              get(value, field) {
                if (field === 'body') return new ReadableStream<Uint8Array>({ cancel });
                return Reflect.get(value, field);
              },
            });
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    await unavailable(
      await app().request(
        f.url(),
        {},
        {
          ...bindings,
          R2: bucket,
          SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS: '50',
        }
      )
    );
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('bounds a stalled primary snapshot query without returning private storage errors', async () => {
    const f = await fixture();
    const primary = new Proxy(env.DATABASE, {
      get(target, prop) {
        if (prop === 'prepare')
          return (sql: string) => {
            const statement = target.prepare(sql);
            if (!sql.includes('session_snapshots')) return statement;
            const stalled = (current: D1PreparedStatement): D1PreparedStatement =>
              new Proxy(current, {
                get(value, field) {
                  if (field === 'bind')
                    return (...values: unknown[]) => stalled(value.bind(...values));
                  if (['all', 'first', 'raw', 'run'].includes(String(field)))
                    return () => new Promise(() => undefined);
                  const method = Reflect.get(value, field);
                  return typeof method === 'function' ? method.bind(value) : method;
                },
              });
            return stalled(statement);
          };
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await app().request(
      f.url(),
      {},
      {
        ...bindings,
        DATABASE: primary,
        SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS: '50',
      }
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Retained snapshot download unavailable',
    });
  });

  it('bounds blocked object retrieval and returns a private generic failure', async () => {
    const f = await fixture();
    const bucket = new Proxy(env.R2, {
      get(target, prop) {
        if (prop === 'get') return () => new Promise(() => undefined);
        const value = Reflect.get(target, prop);
        return typeof value === 'function' ? value.bind(target) : value;
      },
    });
    const response = await app().request(
      f.url(),
      {},
      { ...bindings, R2: bucket, SESSION_SNAPSHOT_TRANSFER_IDLE_TIMEOUT_MS: '10' }
    );
    expect(response.status).toBe(500);
    expect(response.headers.get('cache-control')).toBe('private, no-store');
    expect(await response.json()).toEqual({
      error: 'INTERNAL_ERROR',
      message: 'Retained snapshot download unavailable',
    });
  });
});
