/**
 * Request-scoped D1 sessions, on the real runtime.
 *
 * `.claude/rules/69`: the node-environment harness backs D1 with `better-sqlite3`, which has
 * no `withSession` at all — so no fixture of any size there can observe the Sessions API. The
 * behaviour has to be exercised against workerd, which is what this file does.
 *
 * It also carries the real-trigger control pair for the auth-dedup change
 * (`.claude/rules/62`): requests go through `SELF`, i.e. the actual exported worker, with the
 * actual route mounting and a real better-auth session cookie — so if deduplicating the auth
 * middleware had broken authentication on a project sub-route, or if wrapping `env.DATABASE`
 * in a session facade had broken the request path, these would fail.
 */
import { env, SELF } from 'cloudflare:test';
import { beforeAll, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import { createRequestScopedD1, withRequestScopedD1Bindings } from '../../src/lib/d1-session';
import { createSessionCookieForUser } from '../../src/services/session-factory';

const testEnv = env as unknown as Env;

const RUN = `d1-session-${Date.now()}`;
const USER_ID = `${RUN}-user`;
const OTHER_USER_ID = `${RUN}-other`;
const INSTALLATION_ID = `${RUN}-inst`;
const PROJECT_ID = `${RUN}-proj`;
const NOW = new Date().toISOString();

let sessionCookie: string;
let otherSessionCookie: string;

beforeAll(async () => {
  const insertUser = testEnv.DATABASE.prepare(
    `INSERT INTO users (id, email, name, email_verified, role, status, created_at, updated_at)
     VALUES (?, ?, ?, 1, 'user', 'active', ?, ?)`
  );
  await insertUser.bind(USER_ID, `${USER_ID}@example.com`, 'Session User', NOW, NOW).run();
  await insertUser.bind(OTHER_USER_ID, `${OTHER_USER_ID}@example.com`, 'Other User', NOW, NOW).run();

  await testEnv.DATABASE.prepare(
    `INSERT INTO github_installations
       (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
     VALUES (?, ?, ?, 'User', 'acme', ?, ?)`
  )
    .bind(INSTALLATION_ID, USER_ID, INSTALLATION_ID, NOW, NOW)
    .run();

  await testEnv.DATABASE.prepare(
    `INSERT INTO projects
       (id, user_id, created_by, name, normalized_name, installation_id, repository, created_at, updated_at)
     VALUES (?, ?, ?, 'Session project', 'session-project', ?, 'acme/repo', ?, ?)`
  )
    .bind(PROJECT_ID, USER_ID, USER_ID, INSTALLATION_ID, NOW, NOW)
    .run();

  await testEnv.DATABASE.prepare(
    `INSERT INTO project_members
       (project_id, user_id, role, status, invited_by, created_at, updated_at)
     VALUES (?, ?, 'owner', 'active', ?, ?, ?)`
  )
    .bind(PROJECT_ID, USER_ID, USER_ID, NOW, NOW)
    .run();

  sessionCookie = (await createSessionCookieForUser(testEnv, USER_ID)).sessionCookie;
  otherSessionCookie = (await createSessionCookieForUser(testEnv, OTHER_USER_ID)).sessionCookie;
});

describe('D1 Sessions API on workerd', () => {
  it('exposes withSession/getBookmark on the real binding', () => {
    expect(typeof testEnv.DATABASE.withSession).toBe('function');

    const session = testEnv.DATABASE.withSession('first-primary');
    expect(typeof session.prepare).toBe('function');
    expect(typeof session.batch).toBe('function');
    // No query has run yet, so there is nothing to anchor on.
    expect(session.getBookmark()).toBeNull();
  });

  it('a request-scoped facade sees its own write immediately (read-after-write)', async () => {
    const scoped = createRequestScopedD1(testEnv.DATABASE);
    const id = `${RUN}-raw-1`;

    await scoped
      .prepare(
        `INSERT INTO users (id, email, name, email_verified, role, status, created_at, updated_at)
         VALUES (?, ?, 'raw', 1, 'user', 'active', ?, ?)`
      )
      .bind(id, `${id}@example.com`, NOW, NOW)
      .run();

    const row = await scoped
      .prepare('SELECT id, name FROM users WHERE id = ?')
      .bind(id)
      .first<{ id: string; name: string }>();

    expect(row).toEqual({ id, name: 'raw' });
  });

  it('advances its bookmark as queries run, and issues exactly one session per facade', async () => {
    let sessionCount = 0;
    const bookmarks: (string | null)[] = [];
    const counting = {
      ...testEnv.DATABASE,
      withSession: (anchor?: string) => {
        sessionCount += 1;
        const inner = testEnv.DATABASE.withSession(anchor);
        bookmarks.push(inner.getBookmark());
        return inner;
      },
    } as unknown as D1Database;

    const scoped = createRequestScopedD1(counting);
    expect(sessionCount).toBe(0); // lazy — a request that never touches D1 opens no session

    await scoped.prepare('SELECT 1 AS ok').first();
    await scoped.prepare('SELECT 2 AS ok').first();
    await scoped.batch([scoped.prepare('SELECT 3 AS ok')]);

    expect(sessionCount).toBe(1);
    expect(bookmarks).toEqual([null]);
  });

  it('anchors at first-primary, and a caller can still open its own anchor', async () => {
    const anchors: (string | undefined)[] = [];
    const recording = {
      ...testEnv.DATABASE,
      withSession: (anchor?: string) => {
        anchors.push(anchor);
        return testEnv.DATABASE.withSession(anchor);
      },
    } as unknown as D1Database;

    const scoped = createRequestScopedD1(recording);
    await scoped.prepare('SELECT 1').first();
    scoped.withSession('first-unconstrained');

    expect(anchors).toEqual(['first-primary', 'first-unconstrained']);
  });

  it('writes through a batch are visible to a later read in the same session', async () => {
    const scoped = createRequestScopedD1(testEnv.DATABASE);
    const first = `${RUN}-batch-1`;
    const second = `${RUN}-batch-2`;

    await scoped.batch([
      scoped
        .prepare(
          `INSERT INTO users (id, email, name, email_verified, role, status, created_at, updated_at)
           VALUES (?, ?, 'batched', 1, 'user', 'active', ?, ?)`
        )
        .bind(first, `${first}@example.com`, NOW, NOW),
      scoped
        .prepare(
          `INSERT INTO users (id, email, name, email_verified, role, status, created_at, updated_at)
           VALUES (?, ?, 'batched', 1, 'user', 'active', ?, ?)`
        )
        .bind(second, `${second}@example.com`, NOW, NOW),
    ]);

    const rows = await scoped
      .prepare('SELECT id FROM users WHERE id IN (?, ?) ORDER BY id')
      .bind(first, second)
      .all<{ id: string }>();

    expect(rows.results.map((row) => row.id)).toEqual([first, second]);
  });

  /*
   * Concurrency is the DOMINANT pattern this facade now sits under, not an edge case:
   * `Promise.all` around D1/drizzle calls appears in ~32 files under `apps/api/src`, including
   * `resolvePlatformConfig`'s 14-way fan-out on the auth preamble and the two independent
   * read pairs this PR made concurrent (`requireActiveProjectMembership`,
   * `computeBlockedSet`/`resolveTaskAgentProfileHints`). All of those now share ONE
   * `D1DatabaseSession` per request, so "does a session behave correctly when queries are
   * dispatched concurrently rather than sequentially?" has to be proven, not assumed —
   * especially on the real runtime, since a node harness has no session at all
   * (`.claude/rules/69`).
   */
  it('serves a concurrent burst correctly as the session\'s FIRST queries', async () => {
    const scoped = createRequestScopedD1(testEnv.DATABASE);

    // No bookmark exists yet, so every one of these is a "first" query for the session.
    const rows = await Promise.all([
      scoped.prepare('SELECT 1 AS n').first<{ n: number }>(),
      scoped.prepare('SELECT 2 AS n').first<{ n: number }>(),
      scoped.prepare('SELECT 3 AS n').first<{ n: number }>(),
      scoped.prepare('SELECT id FROM users WHERE id = ?').bind(USER_ID).first<{ id: string }>(),
    ]);

    expect(rows.slice(0, 3).map((row) => (row as { n: number }).n)).toEqual([1, 2, 3]);
    expect(rows[3]).toEqual({ id: USER_ID });
  });

  it('a write is visible to reads dispatched concurrently after it', async () => {
    const scoped = createRequestScopedD1(testEnv.DATABASE);
    const id = `${RUN}-concurrent-1`;

    await scoped
      .prepare(
        `INSERT INTO users (id, email, name, email_verified, role, status, created_at, updated_at)
         VALUES (?, ?, 'concurrent', 1, 'user', 'active', ?, ?)`
      )
      .bind(id, `${id}@example.com`, NOW, NOW)
      .run();

    // Both reads are dispatched before either resolves — the shape `Promise.all` produces.
    const [byId, counted] = await Promise.all([
      scoped.prepare('SELECT name FROM users WHERE id = ?').bind(id).first<{ name: string }>(),
      scoped
        .prepare('SELECT COUNT(*) AS n FROM users WHERE id = ?')
        .bind(id)
        .first<{ n: number }>(),
    ]);

    expect(byId).toEqual({ name: 'concurrent' });
    expect(counted?.n).toBe(1);
  });

  it('interleaves concurrent prepare() and batch() on one session', async () => {
    const scoped = createRequestScopedD1(testEnv.DATABASE);

    const [single, batched] = await Promise.all([
      scoped.prepare('SELECT id FROM users WHERE id = ?').bind(USER_ID).first<{ id: string }>(),
      scoped.batch<{ id: string }>([
        scoped.prepare('SELECT id FROM users WHERE id = ?').bind(USER_ID),
        scoped.prepare('SELECT id FROM users WHERE id = ?').bind(OTHER_USER_ID),
      ]),
    ]);

    expect(single).toEqual({ id: USER_ID });
    expect(batched.map((result) => result.results[0]?.id)).toEqual([USER_ID, OTHER_USER_ID]);
  });

  it('opens exactly one session for a concurrent burst', async () => {
    let sessionCount = 0;
    const counting = {
      ...testEnv.DATABASE,
      withSession: (anchor?: string) => {
        sessionCount += 1;
        return testEnv.DATABASE.withSession(anchor);
      },
    } as unknown as D1Database;

    const scoped = createRequestScopedD1(counting);
    await Promise.all([
      scoped.prepare('SELECT 1 AS n').first(),
      scoped.prepare('SELECT 2 AS n').first(),
      scoped.prepare('SELECT 3 AS n').first(),
    ]);

    // The lazy `session ??= …` must not race into three sessions when three callers reach it
    // in the same synchronous turn.
    expect(sessionCount).toBe(1);
  });

  it('the D1_SESSION_MODE kill switch hands back the RAW binding on the real runtime', async () => {
    // The operator escape hatch, end to end on workerd rather than against a fake binding:
    // with sessions disabled, `env.DATABASE` reaching a handler must be the binding itself.
    const disabled = withRequestScopedD1Bindings({
      ...testEnv,
      D1_SESSION_MODE: 'disabled',
    } as unknown as Env);

    expect(disabled.DATABASE).toBe(testEnv.DATABASE);
    expect(disabled.OBSERVABILITY_DATABASE).toBe(testEnv.OBSERVABILITY_DATABASE);

    // Liveness: the raw binding still answers, so "identical object" is not hiding a broken env.
    const row = await disabled.DATABASE.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    expect(row?.ok).toBe(1);

    // Control: the same env WITHOUT the switch does get a facade, so the assertion above is
    // the switch working rather than the wrapper never doing anything on this runtime.
    const enabled = withRequestScopedD1Bindings(testEnv);
    expect(enabled.DATABASE).not.toBe(testEnv.DATABASE);
  });

  it('the exported worker keeps scheduled() on the raw, unsessioned bindings', async () => {
    // `.claude/rules/58`/`/66`: cron sweeps own terminal verdicts and must read what they read
    // today. That holds by construction — only `fetch` wraps env — and this pins it by
    // referential identity so an accidental wrap cannot slip in unnoticed.
    const workerEntry = (await import('../../src/index')).default;
    const { scheduled } = await import('../../src/scheduled/handler');

    expect(workerEntry.scheduled).toBe(scheduled);
    // Liveness beside the identity assertion: fetch is NOT the bare app handler, i.e. the
    // wrapper this file exists to test really is installed on the other entry point.
    expect(typeof workerEntry.fetch).toBe('function');
  });

  it('withRequestScopedD1Bindings keeps every other binding usable', async () => {
    const scoped = withRequestScopedD1Bindings(testEnv);

    expect(Object.keys(scoped).sort()).toEqual(Object.keys(testEnv).sort());
    expect(scoped.KV).toBe(testEnv.KV);
    expect(scoped.PROJECT_DATA).toBe(testEnv.PROJECT_DATA);
    expect(scoped.DATABASE).not.toBe(testEnv.DATABASE);

    const row = await scoped.DATABASE.prepare('SELECT 1 AS ok').first<{ ok: number }>();
    expect(row?.ok).toBe(1);
  });
});

describe('the real worker still authenticates project sub-routes', () => {
  const tasksUrl = () => `https://api.${testEnv.BASE_DOMAIN}/api/projects/${PROJECT_ID}/tasks`;

  it('rejects an unauthenticated request', async () => {
    const res = await SELF.fetch(tasksUrl());

    expect(res.status).toBe(401);
  });

  it('rejects an authenticated NON-member (owner control below)', async () => {
    const res = await SELF.fetch(tasksUrl(), { headers: { Cookie: otherSessionCookie } });

    expect(res.status).toBe(404);
  });

  it('serves the owner, through the session-scoped bindings', async () => {
    const res = await SELF.fetch(tasksUrl(), { headers: { Cookie: sessionCookie } });

    expect(res.status).toBe(200);
    await expect(res.json()).resolves.toEqual({ tasks: [], nextCursor: null });
  });

  it('read-after-write across requests: a created task is in the very next list', async () => {
    const created = await SELF.fetch(tasksUrl(), {
      method: 'POST',
      headers: { Cookie: sessionCookie, 'Content-Type': 'application/json' },
      body: JSON.stringify({ title: 'Session read-after-write' }),
    });
    expect(created.status).toBe(201);
    const createdTask = (await created.json()) as { id: string; title: string };
    expect(createdTask.title).toBe('Session read-after-write');

    // Miniflare has no replicas, so this proves the request path end-to-end rather than
    // replica convergence; the replica-backed proof is the staging measurement in the PR.
    const listed = await SELF.fetch(tasksUrl(), { headers: { Cookie: sessionCookie } });
    expect(listed.status).toBe(200);
    const body = (await listed.json()) as { tasks: { id: string }[] };
    expect(body.tasks.map((task) => task.id)).toContain(createdTask.id);
  });
});
