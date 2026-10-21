/**
 * New-chat profile picker state (idea 01M5EW9H86VD88S7E3WWA1D9X1).
 *
 * Usage and "hide from new chat" are scoped by SQL predicates (user, project, own
 * hand-started chats), so they run against a real SQLite engine (.claude/rules/28):
 * every attack case has an owner-path control.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import { D1_MAX_BOUND_PARAMETERS } from '../../../src/lib/d1-limits';
import {
  getProfilePickerState,
  updateHiddenProfiles,
} from '../../../src/services/agent-profile-picker';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
  createSqliteD1WithBindLimit,
} from '../../helpers/sqlite-d1';

const NOW = new Date('2026-10-21T12:00:00.000Z');
const WINDOW_DAYS = 30;
const daysAgo = (days: number) => new Date(NOW.getTime() - days * 86_400_000).toISOString();

describe('agent profile picker state', () => {
  let sqlite: Database.Database;
  let db: ReturnType<typeof drizzle<typeof schema>>;
  let taskSeq = 0;

  function seedProfile(id: string, projectId: string | null, userId: string) {
    sqlite
      .prepare(
        `INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type, effort, is_builtin, created_at, updated_at)
         VALUES (?, ?, ?, ?, 'claude-code', 'auto', 0, ?, ?)`
      )
      .run(id, projectId, userId, id, NOW.toISOString(), NOW.toISOString());
  }

  function seedTask(overrides: Partial<Record<string, string | number | null>>) {
    const row = {
      id: `task-${++taskSeq}`,
      project_id: 'p1',
      user_id: 'u1',
      title: 'chat',
      status: 'completed',
      triggered_by: 'user',
      dispatch_depth: 0,
      recovery_source_task_id: null,
      agent_profile_hint: 'prof-a',
      created_at: daysAgo(1),
      ...overrides,
    };
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, triggered_by, dispatch_depth,
           recovery_source_task_id, agent_profile_hint, created_at)
         VALUES (@id, @project_id, @user_id, @title, @status, @triggered_by, @dispatch_depth,
           @recovery_source_task_id, @agent_profile_hint, @created_at)`
      )
      .run(row);
  }

  const state = (projectId = 'p1', userId = 'u1') =>
    getProfilePickerState(db, projectId, userId, WINDOW_DAYS, NOW);

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    db = drizzle(createSqliteD1(sqlite), { schema });
    taskSeq = 0;
    seedProfile('prof-a', 'p1', 'u1');
    seedProfile('prof-b', 'p1', 'u2'); // project profile created by another member
    seedProfile('prof-other-project', 'p2', 'u1');
    seedProfile('prof-global-mine', null, 'u1');
    seedProfile('prof-global-theirs', null, 'u2');
  });

  afterEach(() => sqlite.close());

  describe('usage', () => {
    it('counts only the caller’s own hand-started chats in this project and window', async () => {
      seedTask({ agent_profile_hint: 'prof-a', created_at: daysAgo(3) });
      // D1 `datetime('now')` default format, normalised to ISO in the response.
      seedTask({ agent_profile_hint: 'prof-a', created_at: '2026-10-20 09:30:00' });
      seedTask({ agent_profile_hint: 'prof-b', created_at: daysAgo(10) });
      seedTask({ agent_profile_hint: 'prof-b', created_at: daysAgo(40) }); // outside window

      // None of these are the caller choosing a profile for a new chat.
      seedTask({ user_id: 'u2', agent_profile_hint: 'prof-a' });
      seedTask({ dispatch_depth: 1, agent_profile_hint: 'prof-b' });
      seedTask({ triggered_by: 'cron', agent_profile_hint: 'prof-b' });
      seedTask({ recovery_source_task_id: 'task-1', agent_profile_hint: 'prof-b' });
      seedTask({ status: 'draft', agent_profile_hint: 'prof-b' });
      seedTask({ agent_profile_hint: null });
      seedTask({ project_id: 'p2', agent_profile_hint: 'prof-other-project' });

      const result = await state();

      expect(result.usageWindowDays).toBe(WINDOW_DAYS);
      expect(result.usage).toEqual([
        { profileId: 'prof-a', lastUsedAt: '2026-10-20T09:30:00Z', chatCount: 2 },
        { profileId: 'prof-b', lastUsedAt: daysAgo(10), chatCount: 1 },
      ]);
    });

    it('counts a chat started exactly at the window’s start, and not one a moment earlier', async () => {
      const windowStart = daysAgo(WINDOW_DAYS);
      seedTask({ agent_profile_hint: 'prof-a', created_at: windowStart });
      seedTask({
        agent_profile_hint: 'prof-b',
        created_at: new Date(Date.parse(windowStart) - 1).toISOString(),
      });

      expect((await state()).usage).toEqual([
        { profileId: 'prof-a', lastUsedAt: windowStart, chatCount: 1 },
      ]);
    });

    it('returns empty usage for someone with no chats yet (liveness: hidden ids still load)', async () => {
      await updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-a'] });

      const result = await state();

      expect(result.usage).toEqual([]);
      expect(result.hiddenProfileIds).toEqual(['prof-a']);
    });
  });

  describe('hide from new chat', () => {
    it('hides and shows the caller’s own picker entries idempotently', async () => {
      await updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-a', 'prof-global-mine'] });
      const again = await updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-a'] });
      expect(again.sort()).toEqual(['prof-a', 'prof-global-mine']);

      const shown = await updateHiddenProfiles(db, 'p1', 'u1', { unhide: ['prof-a'] });
      expect(shown).toEqual(['prof-global-mine']);
    });

    it('lets a member hide a project profile someone else created (owner-path control)', async () => {
      const hidden = await updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-b'] });
      expect(hidden).toEqual(['prof-b']);
    });

    it('rejects hiding a profile from another project', async () => {
      await expect(
        updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-other-project'] })
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_picker_hidden').get()).toEqual(
        { n: 0 }
      );
    });

    it('rejects hiding another person’s global profile', async () => {
      await expect(
        updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-global-theirs'] })
      ).rejects.toMatchObject({ statusCode: 400 });

      expect(sqlite.prepare('SELECT COUNT(*) AS n FROM agent_profile_picker_hidden').get()).toEqual(
        { n: 0 }
      );
    });

    it('treats showing a profile that was never hidden as a no-op', async () => {
      await updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-a'] });
      await updateHiddenProfiles(db, 'p1', 'u2', { hide: ['prof-b'] });

      const shown = await updateHiddenProfiles(db, 'p1', 'u1', {
        unhide: ['prof-b', 'no-such-profile'],
      });

      expect(shown).toEqual(['prof-a']);
      expect((await state('p1', 'u2')).hiddenProfileIds).toEqual(['prof-b']);
    });

    it('hides and shows more profiles than one D1 statement can bind', async () => {
      const many = Array.from(
        { length: D1_MAX_BOUND_PARAMETERS + 20 },
        (_, index) => `bulk-${index}`
      );
      for (const id of many) seedProfile(id, 'p1', 'u2');
      const limited = drizzle(createSqliteD1WithBindLimit(sqlite, D1_MAX_BOUND_PARAMETERS), {
        schema,
      });

      const hidden = await updateHiddenProfiles(limited, 'p1', 'u1', { hide: many });
      expect(hidden).toHaveLength(many.length);

      const shown = await updateHiddenProfiles(limited, 'p1', 'u1', { unhide: many });
      expect(shown).toEqual([]);
    });

    it('never changes another person’s picker', async () => {
      await updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-a'] });

      // u2 tries to show u1's hidden profile: only u2's own rows are touched.
      await updateHiddenProfiles(db, 'p1', 'u2', { unhide: ['prof-a'] });

      expect((await state('p1', 'u1')).hiddenProfileIds).toEqual(['prof-a']);
      expect((await state('p1', 'u2')).hiddenProfileIds).toEqual([]);
    });

    it('keeps a hidden global profile scoped to the project it was hidden in', async () => {
      await updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-global-mine'] });

      expect((await state('p1', 'u1')).hiddenProfileIds).toEqual(['prof-global-mine']);
      expect((await state('p2', 'u1')).hiddenProfileIds).toEqual([]);
    });

    it('rejects the same profile in hide and unhide', async () => {
      await expect(
        updateHiddenProfiles(db, 'p1', 'u1', { hide: ['prof-a'], unhide: ['prof-a'] })
      ).rejects.toMatchObject({ statusCode: 400 });
    });
  });
});

describe('migration 0201: a hidden row goes with its profile, project or person', () => {
  it('cascades deletes with foreign keys enforced, as D1 does', () => {
    const sqlite = new Database(':memory:');
    try {
      sqlite.pragma('foreign_keys = ON');
      for (const table of ['users', 'projects', 'agent_profiles']) {
        sqlite.exec(`CREATE TABLE ${table} (id TEXT PRIMARY KEY)`);
      }
      applySqliteMigration(
        sqlite,
        new URL('../../../src/db/migrations/0201_agent_profile_picker_hidden.sql', import.meta.url)
      );
      sqlite.exec(`INSERT INTO users (id) VALUES ('u1'), ('u2')`);
      sqlite.exec(`INSERT INTO projects (id) VALUES ('p1'), ('p2')`);
      sqlite.exec(`INSERT INTO agent_profiles (id) VALUES ('a'), ('b'), ('c')`);
      const hide = sqlite.prepare(
        'INSERT INTO agent_profile_picker_hidden (user_id, project_id, profile_id) VALUES (?, ?, ?)'
      );
      hide.run('u1', 'p1', 'a');
      hide.run('u1', 'p1', 'b');
      hide.run('u2', 'p1', 'b');
      hide.run('u1', 'p2', 'c');
      const rows = () =>
        sqlite
          .prepare(
            `SELECT user_id || '/' || project_id || '/' || profile_id AS k
             FROM agent_profile_picker_hidden ORDER BY k`
          )
          .all()
          .map((row) => (row as { k: string }).k);

      sqlite.exec(`DELETE FROM agent_profiles WHERE id = 'a'`);
      expect(rows()).toEqual(['u1/p1/b', 'u1/p2/c', 'u2/p1/b']);

      sqlite.exec(`DELETE FROM projects WHERE id = 'p2'`);
      expect(rows()).toEqual(['u1/p1/b', 'u2/p1/b']);

      sqlite.exec(`DELETE FROM users WHERE id = 'u2'`);
      expect(rows()).toEqual(['u1/p1/b']);
    } finally {
      sqlite.close();
    }
  });
});
