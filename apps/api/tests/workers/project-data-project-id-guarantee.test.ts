/**
 * Vertical slice tests for the ProjectData `projectId` guarantee.
 *
 * `getStub()` no longer calls `ensureProjectId` before every DO operation — it
 * calls it once per (isolate, Durable Object). These tests use the real
 * ProjectData DO in workerd with real D1 to prove the guarantee that removal of
 * the repeated call must not weaken:
 *
 *   1. the service layer persists `do_meta.projectId` before the first real
 *      operation runs, and it stays persisted across later operations;
 *   2. a DO that was never ensured **fails closed** — it skips the D1 write-back
 *      rather than guessing at a project row.
 *
 * The DO cannot recover its own projectId (`idFromName` is one-way), so this row
 * is the only thing standing between the alarm sweeps / summary sync and a
 * silent no-op.
 *
 * See: .claude/rules/35-vertical-slice-testing.md, .claude/rules/11-fail-fast-patterns.md
 */
import { env } from 'cloudflare:test';
import { beforeEach, describe, expect, it } from 'vitest';

import type { Env } from '../../src/env';
import * as svc from '../../src/services/project-data';
import { resetProjectDataEnsureMemo } from '../../src/services/project-data-ensure-memo';
import type { ProjectDataTestDouble } from './support/expected-error-doubles';

const testEnv = env as unknown as Env;

function doubleFor(projectId: string): DurableObjectStub<ProjectDataTestDouble> {
  const id = env.PROJECT_DATA.idFromName(projectId);
  return env.PROJECT_DATA.get(id) as DurableObjectStub<ProjectDataTestDouble>;
}

const SEEDED_AT = '2026-01-01T00:00:00.000Z';
const OWNER_ID = 'user-guarantee';
const INSTALLATION_ID = 'install-guarantee';

/** Seed the FK parents once — `projects` requires a user and an installation. */
async function seedProjectParents(): Promise<void> {
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO users (id, github_id, email, name, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)`
  )
    .bind(OWNER_ID, 'gh-guarantee', 'guarantee@example.test', 'Guarantee', SEEDED_AT, SEEDED_AT)
    .run();
  await env.DATABASE.prepare(
    `INSERT OR IGNORE INTO github_installations
       (id, user_id, installation_id, account_type, account_name, created_at, updated_at)
     VALUES (?, ?, ?, 'User', 'acme', ?, ?)`
  )
    .bind(INSTALLATION_ID, OWNER_ID, 'gh-install-guarantee', SEEDED_AT, SEEDED_AT)
    .run();
}

async function seedProject(projectId: string): Promise<void> {
  await seedProjectParents();
  await env.DATABASE.prepare(
    `INSERT OR REPLACE INTO projects
       (id, user_id, name, normalized_name, repository, default_branch, installation_id,
        created_by, created_at, updated_at, last_activity_at, active_session_count)
     VALUES (?, ?, ?, ?, ?, 'main', ?, ?, ?, ?, ?, 0)`
  )
    .bind(
      projectId,
      OWNER_ID,
      `Guarantee ${projectId}`,
      `guarantee ${projectId}`,
      `acme/${projectId}`,
      INSTALLATION_ID,
      OWNER_ID,
      SEEDED_AT,
      SEEDED_AT,
      SEEDED_AT
    )
    .run();
}

async function readProjectRow(projectId: string) {
  return env.DATABASE.prepare(
    'SELECT last_activity_at, active_session_count FROM projects WHERE id = ?'
  )
    .bind(projectId)
    .first<{ last_activity_at: string; active_session_count: number }>();
}

beforeEach(() => {
  resetProjectDataEnsureMemo();
});

describe('ProjectData projectId guarantee', () => {
  it('persists projectId before the first service-layer operation touches the DO', async () => {
    const projectId = `proj-guarantee-first-${crypto.randomUUID()}`;
    const stub = doubleFor(projectId);

    expect(await stub.readPersistedProjectId()).toBeNull();

    await svc.createSession(testEnv, projectId, null, 'first session');

    expect(await stub.readPersistedProjectId()).toBe(projectId);
  });

  it('keeps projectId persisted across many operations', async () => {
    const projectId = `proj-guarantee-many-${crypto.randomUUID()}`;
    const stub = doubleFor(projectId);

    for (let i = 0; i < 5; i++) {
      await svc.createSession(testEnv, projectId, null, `session ${i}`);
    }

    expect(await stub.readPersistedProjectId()).toBe(projectId);
    const summary = await svc.getSummary(testEnv, projectId);
    expect(summary.activeSessionCount).toBeGreaterThan(0);
  });

  it('persists projectId even when concurrent callers race the first operation', async () => {
    const projectId = `proj-guarantee-race-${crypto.randomUUID()}`;
    const stub = doubleFor(projectId);

    await Promise.all(
      Array.from({ length: 6 }, (_unused, i) =>
        svc.createSession(testEnv, projectId, null, `race ${i}`)
      )
    );

    expect(await stub.readPersistedProjectId()).toBe(projectId);
  });

  it('writes the D1 summary back once the DO knows its projectId', async () => {
    const projectId = `proj-guarantee-sync-${crypto.randomUUID()}`;
    await seedProject(projectId);

    await svc.createSession(testEnv, projectId, null, 'syncs to d1');
    await doubleFor(projectId).runSummarySyncForTest();

    const row = await readProjectRow(projectId);
    expect(row?.active_session_count).toBeGreaterThan(0);
    expect(row?.last_activity_at).not.toBe(SEEDED_AT);
  });

  it('FAILS CLOSED: a never-ensured DO does not write the project summary to D1', async () => {
    const projectId = `proj-guarantee-failclosed-${crypto.randomUUID()}`;
    await seedProject(projectId);

    // Reach the DO directly, bypassing getStub, so projectId is never persisted.
    const stub = doubleFor(projectId);
    await stub.createSession(null, 'never ensured', null, null);
    expect(await stub.readPersistedProjectId()).toBeNull();

    await stub.runSummarySyncForTest();

    // The row must be untouched — no guess, no cross-project write.
    const row = await readProjectRow(projectId);
    expect(row?.active_session_count).toBe(0);
    expect(row?.last_activity_at).toBe(SEEDED_AT);
  });

  it('FAILS CLOSED: an unensured DO leaves every other project row untouched', async () => {
    const victimId = `proj-guarantee-victim-${crypto.randomUUID()}`;
    const unensuredId = `proj-guarantee-unensured-${crypto.randomUUID()}`;
    await seedProject(victimId);
    await seedProject(unensuredId);

    const stub = doubleFor(unensuredId);
    await stub.createSession(null, 'no identity', null, null);
    await stub.runSummarySyncForTest();

    const victim = await readProjectRow(victimId);
    expect(victim?.active_session_count).toBe(0);
    expect(victim?.last_activity_at).toBe(SEEDED_AT);
  });
});
