import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { resolveCommentMentions } from '../../../src/services/comment-mentions';
import { createAdminSettingsEnv } from '../../helpers/admin-settings-env';
import { createSchemaTables } from '../../helpers/sqlite-d1';

/**
 * `resolveCommentMentions` is a project-scoped identity gate (.claude/rules/28): only active
 * members of THIS project may be mentioned, and the display name shown is a server-side
 * snapshot, never client-supplied. These tests run against a real in-memory SQLite engine
 * (not a `.where()`-ignoring mock) so the membership/project predicates are actually proven.
 *
 * `getCommentMentionsMax` is exercised through the real admin-settings-backed resolver
 * (`createAdminSettingsEnv`), not mocked, so the cap test proves the configured value —
 * not a hardcoded constant — is what the function enforces.
 */

type Db = ReturnType<typeof drizzle<typeof schema>>;

let sqlite: Database.Database;
let env: Env;
let db: Db;

beforeEach(() => {
  ({ sqlite, env } = createAdminSettingsEnv());
  createSchemaTables(sqlite, [schema.users, schema.projectMembers]);
  db = drizzle(env.DATABASE, { schema });
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

function seedUser(user: { id: string; email: string; name?: string | null }): void {
  sqlite
    .prepare(
      `INSERT INTO users
         (id, email, email_verified, name, image, github_id, avatar_url, role, status, created_at, updated_at)
       VALUES (?, ?, 0, ?, NULL, NULL, NULL, 'user', 'active', 0, 0)`
    )
    .run(user.id, user.email, user.name ?? null);
}

function seedMember(member: { projectId: string; userId: string; status?: string }): void {
  sqlite
    .prepare(
      `INSERT INTO project_members
         (project_id, user_id, role, status, invited_by, removed_at, created_at, updated_at)
       VALUES (?, ?, 'member', ?, NULL, NULL, '2026-01-01T00:00:00Z', '2026-01-01T00:00:00Z')`
    )
    .run(member.projectId, member.userId, member.status ?? 'active');
}

function setCommentMentionsMax(value: number): void {
  sqlite
    .prepare(
      `INSERT OR REPLACE INTO platform_settings (key, value, updated_at, updated_by)
       VALUES ('collaboration.commentMentionsMax', ?, '2026-01-01T00:00:00Z', NULL)`
    )
    .run(JSON.stringify(value));
}

describe('resolveCommentMentions', () => {
  it('resolves an active project member with a server-snapshotted display name', async () => {
    seedUser({ id: 'user-a', email: 'alice@example.com', name: 'Alice A.' });
    seedMember({ projectId: 'project-1', userId: 'user-a' });

    const result = await resolveCommentMentions(env, db, 'project-1', [{ userId: 'user-a' }]);

    expect(result).toEqual([{ userId: 'user-a', displayName: 'Alice A.' }]);
  });

  it('falls back to the email local part when the member has no name set', async () => {
    seedUser({ id: 'user-b', email: 'bob@example.com', name: null });
    seedMember({ projectId: 'project-1', userId: 'user-b' });

    const result = await resolveCommentMentions(env, db, 'project-1', [{ userId: 'user-b' }]);

    expect(result).toEqual([{ userId: 'user-b', displayName: 'bob' }]);
  });

  it('drops an inactive member while keeping an active member requested in the same call', async () => {
    seedUser({ id: 'user-active', email: 'active@example.com', name: 'Active One' });
    seedMember({ projectId: 'project-1', userId: 'user-active', status: 'active' });
    seedUser({ id: 'user-suspended', email: 'suspended@example.com', name: 'Suspended One' });
    seedMember({ projectId: 'project-1', userId: 'user-suspended', status: 'suspended' });

    const result = await resolveCommentMentions(env, db, 'project-1', [
      { userId: 'user-active' },
      { userId: 'user-suspended' },
    ]);

    expect(result).toEqual([{ userId: 'user-active', displayName: 'Active One' }]);
  });

  it('drops a member of a different project (attack) while keeping the same-project member (control)', async () => {
    seedUser({ id: 'user-other-project', email: 'other@example.com', name: 'Other Project' });
    seedMember({ projectId: 'project-2', userId: 'user-other-project', status: 'active' });
    seedUser({ id: 'user-same-project', email: 'same@example.com', name: 'Same Project' });
    seedMember({ projectId: 'project-1', userId: 'user-same-project', status: 'active' });

    const result = await resolveCommentMentions(env, db, 'project-1', [
      { userId: 'user-other-project' },
      { userId: 'user-same-project' },
    ]);

    expect(result).toEqual([{ userId: 'user-same-project', displayName: 'Same Project' }]);
  });

  it('dedupes repeated ids and preserves the order they were first requested in', async () => {
    seedUser({ id: 'user-f', email: 'f@example.com', name: 'F' });
    seedMember({ projectId: 'project-1', userId: 'user-f' });
    seedUser({ id: 'user-g', email: 'g@example.com', name: 'G' });
    seedMember({ projectId: 'project-1', userId: 'user-g' });

    const result = await resolveCommentMentions(env, db, 'project-1', [
      { userId: 'user-g' },
      { userId: 'user-f' },
      { userId: 'user-g' },
    ]);

    expect(result).toEqual([
      { userId: 'user-g', displayName: 'G' },
      { userId: 'user-f', displayName: 'F' },
    ]);
  });

  it('rejects a mention list larger than the admin-configured cap with the exact 400 message', async () => {
    setCommentMentionsMax(2);

    await expect(
      resolveCommentMentions(env, db, 'project-1', [
        { userId: 'user-1' },
        { userId: 'user-2' },
        { userId: 'user-3' },
      ])
    ).rejects.toMatchObject({
      statusCode: 400,
      error: 'BAD_REQUEST',
      message: 'A comment can mention at most 2 people',
    });
  });

  it('returns [] without touching the DB when input is undefined, empty, or whitespace-only', async () => {
    const selectSpy = vi.spyOn(db, 'select');

    expect(await resolveCommentMentions(env, db, 'project-1', undefined)).toEqual([]);
    expect(await resolveCommentMentions(env, db, 'project-1', [])).toEqual([]);
    expect(await resolveCommentMentions(env, db, 'project-1', [{ userId: '   ' }])).toEqual([]);

    expect(selectSpy).not.toHaveBeenCalled();
  });
});
