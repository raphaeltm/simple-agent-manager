import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const writes = vi.hoisted(() => vi.fn());
vi.mock('../../../src/services/project-data', () => ({ recordResourceLink: writes }));
vi.mock('../../../src/services/admin-settings', () => ({
  resolveAdminSettingDetailsMany: vi
    .fn()
    .mockResolvedValue([
      { value: 300000 },
      { value: 100 },
      { value: 100 },
      { value: 100000 },
      { value: 50 },
      { value: 500 },
    ]),
}));

import type { Env } from '../../../src/env';
import { recordLink } from '../../../src/operations/link-core';

function fixture() {
  const db = new Database(':memory:');
  db.exec(`CREATE TABLE projects(id TEXT PRIMARY KEY,repository TEXT);
    CREATE TABLE tasks(id TEXT PRIMARY KEY,project_id TEXT,status TEXT,
      is_idea INTEGER NOT NULL DEFAULT 0);
    CREATE TABLE project_files(id TEXT PRIMARY KEY,project_id TEXT);
    INSERT INTO projects VALUES ('own','owner/repo'),('other','else/repo'),('empty',NULL);
    INSERT INTO tasks VALUES
      ('idea-own','own','draft',1),('idea-other','other','draft',1),
      ('idea-empty','empty','draft',1),('ordinary-task','own','ready',0),
      -- The two rows only the flag can tell apart from an idea and from an ordinary task:
      -- an undispatched ordinary task is also 'draft', and a finished idea is also 'completed'.
      ('ordinary-draft','own','draft',0),('idea-done','own','completed',1);
    INSERT INTO project_files VALUES ('file-own','own'),('file-other','other');`);
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
      }),
    }),
  } as unknown as D1Database;
  return { db, env: { DATABASE: d1 } as Env };
}

describe('resource links enforce final project predicate in real SQL', () => {
  beforeEach(() => {
    writes.mockReset().mockResolvedValue('written');
  });
  it('accepts an own idea and file, rejects foreign idea and file', async () => {
    const { db, env } = fixture();
    try {
      const input = {
        sourceKind: 'idea' as const,
        sourceId: 'idea-own',
        targetKind: 'file' as const,
        targetId: 'file-own',
        relation: 'linked' as const,
        origin: 'explicit' as const,
        context: null,
      };
      await recordLink(env, 'own', input);
      expect(writes).toHaveBeenCalledTimes(1);
      await expect(recordLink(env, 'own', { ...input, targetId: 'file-other' })).rejects.toThrow();
      await expect(recordLink(env, 'own', { ...input, sourceId: 'idea-other' })).rejects.toThrow();
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
  it('rejects an undispatched ordinary task, which is also a draft', async () => {
    // The case only `is_idea = 1` can refuse. `POST /api/projects/:projectId/tasks` creates
    // every ordinary task in `draft`, so the old `status = 'draft'` definition accepted this
    // row as an idea; under the flag it is refused in every status.
    const { db, env } = fixture();
    try {
      const input = {
        sourceKind: 'idea' as const,
        sourceId: 'ordinary-draft',
        targetKind: 'file' as const,
        targetId: 'file-own',
        relation: 'linked' as const,
        origin: 'explicit' as const,
        context: null,
      };
      await expect(recordLink(env, 'own', input)).rejects.toThrow('Resource');
      expect(writes).not.toHaveBeenCalled();
      // Owner control: a real idea in the same project still links, so the rejection above
      // cannot pass by the write path being broken.
      await recordLink(env, 'own', { ...input, sourceId: 'idea-own' });
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
  it('still treats a finished idea as an idea', async () => {
    // The other half of the flag: a done idea is `completed`, which is otherwise an ordinary
    // finished task, so only `is_idea` keeps it linkable.
    const { db, env } = fixture();
    try {
      await recordLink(env, 'own', {
        sourceKind: 'idea',
        sourceId: 'idea-done',
        targetKind: 'file',
        targetId: 'file-own',
        relation: 'linked',
        origin: 'explicit',
        context: null,
      });
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
  it('rejects an ordinary task as an idea while accepting a draft idea', async () => {
    const { db, env } = fixture();
    try {
      const input = {
        sourceKind: 'idea' as const,
        sourceId: 'ordinary-task',
        targetKind: 'file' as const,
        targetId: 'file-own',
        relation: 'linked' as const,
        origin: 'explicit' as const,
        context: null,
      };
      await expect(recordLink(env, 'own', input)).rejects.toThrow('Resource');
      await expect(
        recordLink(env, 'own', {
          ...input,
          sourceId: 'idea-own',
          targetKind: 'idea',
          targetId: 'ordinary-task',
          relation: 'related',
        })
      ).rejects.toThrow('Resource');
      expect(writes).not.toHaveBeenCalled();
      await recordLink(env, 'own', { ...input, sourceId: 'idea-own' });
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
  it('accepts own repository PR and rejects another repository', async () => {
    const { db, env } = fixture();
    try {
      const input = {
        sourceKind: 'idea' as const,
        sourceId: 'idea-own',
        targetKind: 'pr' as const,
        targetId: 'https://github.com/owner/repo/pull/42',
        relation: 'linked' as const,
        origin: 'explicit' as const,
        context: null,
      };
      await recordLink(env, 'own', input);
      await expect(
        recordLink(env, 'own', { ...input, targetId: 'https://github.com/else/repo/pull/42' })
      ).rejects.toThrow();
      await expect(recordLink(env, 'empty', { ...input, sourceId: 'idea-empty' })).rejects.toThrow(
        'Resource'
      );
      expect(writes).toHaveBeenCalledTimes(1);
    } finally {
      db.close();
    }
  });
});
