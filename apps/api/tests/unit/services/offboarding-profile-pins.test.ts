/**
 * Offboarding removes a departing member's personal profile pins on that project's
 * profiles, and only those: their pins on their own global profiles, on another
 * project's profiles, and other members' pins stay. Real preview/apply services on a
 * real SQL engine, because the scope is a SQL predicate (rule 28).
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { AppDb } from '../../../src/middleware/project-auth';
import { applyProjectMemberOffboarding } from '../../../src/services/project-offboarding-apply';
import { createProjectMemberOffboardingPreview } from '../../../src/services/project-offboarding-preview';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const NOW = '2026-11-01T00:00:00.000Z';
const OWNER = 'owner-1';
const LEAVER = 'maint-2';

function fixture() {
  const sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  for (const userId of [OWNER, LEAVER]) {
    sqlite
      .prepare(`INSERT INTO users (id, email, role, status) VALUES (?, ?, 'user', 'active')`)
      .run(userId, `${userId}@example.com`);
  }
  for (const projectId of ['proj-1', 'proj-2']) {
    sqlite
      .prepare(
        `INSERT INTO projects (id, user_id, name, normalized_name, installation_id, repository,
           default_branch, status, created_by, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'inst-1', 'acme/repo', 'main', 'active', ?, ?, ?)`
      )
      .run(projectId, OWNER, projectId, projectId, OWNER, NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO project_members (project_id, user_id, role, status, created_at, updated_at)
         VALUES (?, ?, 'owner', 'active', ?, ?), (?, ?, 'maintainer', 'active', ?, ?)`
      )
      .run(projectId, OWNER, NOW, NOW, projectId, LEAVER, NOW, NOW);
  }
  const profiles: Array<[id: string, userId: string, projectId: string | null]> = [
    ['prof-proj-1', OWNER, 'proj-1'],
    ['prof-proj-2', OWNER, 'proj-2'],
    ['prof-leaver-global', LEAVER, null],
  ];
  for (const [id, userId, projectId] of profiles) {
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, user_id, name, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(id, projectId, userId, id, NOW, NOW);
  }
  for (const userId of [OWNER, LEAVER]) {
    sqlite
      .prepare(
        `INSERT INTO cc_credentials (id, owner_id, name, kind, encrypted_token, iv, created_at, updated_at)
         VALUES (?, ?, 'Max', 'oauth-token', 'enc', 'iv', ?, ?)`
      )
      .run(`cred-${userId}`, userId, NOW, NOW);
    sqlite
      .prepare(
        `INSERT INTO cc_configurations (id, owner_id, name, consumer_kind, consumer_target,
           credential_id, created_at, updated_at)
         VALUES (?, ?, 'Max', 'agent', 'claude-code', ?, ?, ?)`
      )
      .run(`cfg-${userId}`, userId, `cred-${userId}`, NOW, NOW);
  }
  const pins: Array<[id: string, userId: string, profileId: string]> = [
    ['pin-leaver-proj-1', LEAVER, 'prof-proj-1'],
    ['pin-leaver-proj-2', LEAVER, 'prof-proj-2'],
    ['pin-leaver-global', LEAVER, 'prof-leaver-global'],
    ['pin-owner-proj-1', OWNER, 'prof-proj-1'],
  ];
  for (const [id, userId, profileId] of pins) {
    sqlite
      .prepare(
        `INSERT INTO cc_profile_attachments (id, configuration_id, user_id, agent_profile_id,
           consumer_kind, consumer_target, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'agent', 'claude-code', ?, ?)`
      )
      .run(id, `cfg-${userId}`, userId, profileId, NOW, NOW);
  }
  const env = { DATABASE: createSqliteD1(sqlite) } as Env;
  const db = drizzle(env.DATABASE, { schema }) as AppDb;
  const project = sqlite.prepare(`SELECT * FROM projects WHERE id = 'proj-1'`).get() as never;
  return {
    sqlite,
    env,
    db,
    project: { ...(project as object), id: 'proj-1' } as schema.Project,
  };
}

function remainingPins(sqlite: Database.Database): string[] {
  return (
    sqlite.prepare(`SELECT id FROM cc_profile_attachments ORDER BY id`).all() as Array<{
      id: string;
    }>
  ).map((row) => row.id);
}

describe('offboarding and personal profile pins', () => {
  it('previews the leaver’s pins on this project’s profiles without deleting them', async () => {
    const f = fixture();
    const preview = await createProjectMemberOffboardingPreview({
      db: f.db,
      database: f.env.DATABASE,
      project: f.project,
      memberUserId: LEAVER,
      requestedBy: OWNER,
      defaultAgentType: 'claude-code',
    });

    expect(preview.personalProfilePinCount).toBe(1);
    expect(preview.canApply).toBe(true);
    expect(remainingPins(f.sqlite)).toHaveLength(4);
  });

  it('deletes only the leaver’s pins on this project’s profiles when they are removed', async () => {
    const f = fixture();
    const preview = await createProjectMemberOffboardingPreview({
      db: f.db,
      database: f.env.DATABASE,
      project: f.project,
      memberUserId: LEAVER,
      requestedBy: OWNER,
      defaultAgentType: 'claude-code',
    });
    const applied = await applyProjectMemberOffboarding({
      db: f.db,
      project: f.project,
      memberUserId: LEAVER,
      actorUserId: OWNER,
      planId: preview.offboardingPlanId,
      actions: [],
      finalMemberStatus: 'removed',
      defaultAgentType: 'claude-code',
    });

    expect(applied.status).toBe('removed');
    expect(applied.removedProfilePinCount).toBe(1);
    expect(remainingPins(f.sqlite)).toEqual([
      'pin-leaver-global',
      'pin-leaver-proj-2',
      'pin-owner-proj-1',
    ]);
  });

  it('a failed pin delete leaves the member active, and the same plan can be retried', async () => {
    const f = fixture();
    const preview = await createProjectMemberOffboardingPreview({
      db: f.db,
      database: f.env.DATABASE,
      project: f.project,
      memberUserId: LEAVER,
      requestedBy: OWNER,
      defaultAgentType: 'claude-code',
    });
    const apply = () =>
      applyProjectMemberOffboarding({
        db: f.db,
        project: f.project,
        memberUserId: LEAVER,
        actorUserId: OWNER,
        planId: preview.offboardingPlanId,
        actions: [],
        finalMemberStatus: 'removed',
        defaultAgentType: 'claude-code',
      });
    const leaverStatus = () =>
      (
        f.sqlite
          .prepare(`SELECT status FROM project_members WHERE project_id = 'proj-1' AND user_id = ?`)
          .get(LEAVER) as { status: string }
      ).status;

    f.sqlite.exec(`CREATE TRIGGER fail_pin_delete BEFORE DELETE ON cc_profile_attachments
      BEGIN SELECT RAISE(ABORT, 'pin delete failed'); END;`);
    await expect(apply()).rejects.toThrow();
    expect(leaverStatus()).toBe('active');
    expect(remainingPins(f.sqlite)).toContain('pin-leaver-proj-1');

    f.sqlite.exec(`DROP TRIGGER fail_pin_delete`);
    const applied = await apply();
    expect(applied.status).toBe('removed');
    expect(leaverStatus()).toBe('removed');
    expect(remainingPins(f.sqlite)).not.toContain('pin-leaver-proj-1');
  });
});
