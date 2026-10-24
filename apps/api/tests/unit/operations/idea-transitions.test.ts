/**
 * Idea status transitions, against a real SQL engine.
 *
 * Three call sites used to disagree about what a person may do to an idea: `idea-core.ts`
 * allowed `ready → completed`, `services/task-status.ts` forbade it and offered no way back
 * from `completed`, and the generic task status route validated idea rows with the *task*
 * table. These tests pin the one table they all ask now, and the last block proves the two
 * surfaces agree by driving both of them over the same fixture.
 *
 * The project predicate is a SQL `WHERE`, so it is tested against SQLite rather than a mock
 * whose `.where()` ignores its arguments (rule 28). Every attack case has an owner control.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { OperationError } from '../../../src/operations/errors';
import { updateIdea } from '../../../src/operations/idea-core';
import {
  acknowledgeIdeaMerge,
  applyIdeaStatusTransition,
  canTransitionIdeaStatus,
  getAllowedIdeaTransitions,
  validateIdeaStatusTransition,
} from '../../../src/operations/idea-transitions';
import type { OperationContext } from '../../../src/operations/types';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const PROJECT = 'project-1';
const OTHER_PROJECT = 'project-2';
const USER = 'user-1';

describe('the idea transition table', () => {
  it('lets a person finish, park and reopen an idea', () => {
    expect(getAllowedIdeaTransitions('draft')).toEqual(['ready', 'completed', 'cancelled']);
    expect(getAllowedIdeaTransitions('ready')).toEqual(['draft', 'completed', 'cancelled']);
    expect(getAllowedIdeaTransitions('completed')).toEqual(['draft']);
    expect(getAllowedIdeaTransitions('cancelled')).toEqual(['draft']);
  });

  it('allows ready → completed, which the task table forbade', () => {
    expect(canTransitionIdeaStatus('ready', 'completed')).toBe(true);
    expect(validateIdeaStatusTransition('ready', 'completed')).toBeNull();
  });

  it('offers a way back from done and parked, because people change their minds', () => {
    expect(canTransitionIdeaStatus('completed', 'draft')).toBe(true);
    expect(canTransitionIdeaStatus('cancelled', 'draft')).toBe(true);
  });

  it('refuses a transition that is not on the table, and says what is', () => {
    expect(validateIdeaStatusTransition('completed', 'cancelled')).toBe(
      'Invalid status transition: completed → cancelled. Allowed: draft'
    );
  });

  it('refuses a status that is not an idea status at all', () => {
    expect(validateIdeaStatusTransition('draft', 'in_progress')).toBe(
      "Not an idea status: 'in_progress'"
    );
    expect(validateIdeaStatusTransition('queued', 'completed')).toBe(
      "Not an idea status: 'queued'"
    );
  });

  it('treats a no-op as allowed', () => {
    expect(canTransitionIdeaStatus('draft', 'draft')).toBe(true);
  });
});

describe('applyIdeaStatusTransition', () => {
  let sqlite: Database.Database;
  let ctx: OperationContext;

  function seedIdea(
    id: string,
    overrides: { projectId?: string; status?: string; isIdea?: number } = {}
  ) {
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, is_idea, priority, task_mode,
           dispatch_depth, created_by, created_at, updated_at, triggered_by)
         VALUES (?, ?, ?, ?, ?, ?, 0, 'task', 0, ?, '2026-10-20T00:00:00.000Z',
                 '2026-10-20T00:00:00.000Z', 'user')`
      )
      .run(
        id,
        overrides.projectId ?? PROJECT,
        USER,
        `Idea ${id}`,
        overrides.status ?? 'draft',
        overrides.isIdea ?? 1,
        USER
      );
  }

  function readIdea(id: string) {
    return sqlite
      .prepare('SELECT status, completed_at, idea_merge_ack_at FROM tasks WHERE id = ?')
      .get(id) as
      { status: string; completed_at: string | null; idea_merge_ack_at: string | null } | undefined;
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    ctx = {
      // `update_idea` builds a link back to the idea, so it needs the app's domain.
      env: { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env,
      requestId: 'test',
      actor: { userId: USER, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
    };
  });

  afterEach(() => sqlite.close());

  it('marks an idea done and stamps when it finished', async () => {
    seedIdea('idea-1');
    const result = await applyIdeaStatusTransition(ctx, {
      projectId: PROJECT,
      ideaId: 'idea-1',
      status: 'completed',
    });
    expect(result).toMatchObject({ fromStatus: 'draft', toStatus: 'completed', changed: true });
    const row = readIdea('idea-1');
    expect(row?.status).toBe('completed');
    expect(row?.completed_at).toBeTruthy();
  });

  it('clears completed_at again when the idea is reopened', async () => {
    seedIdea('idea-1');
    await applyIdeaStatusTransition(ctx, {
      projectId: PROJECT,
      ideaId: 'idea-1',
      status: 'completed',
    });
    await applyIdeaStatusTransition(ctx, {
      projectId: PROJECT,
      ideaId: 'idea-1',
      status: 'draft',
    });
    const row = readIdea('idea-1');
    expect(row?.status).toBe('draft');
    expect(row?.completed_at).toBeNull();
  });

  it('records the transition as a status event', async () => {
    seedIdea('idea-1');
    await applyIdeaStatusTransition(ctx, {
      projectId: PROJECT,
      ideaId: 'idea-1',
      status: 'cancelled',
    });
    const events = sqlite
      .prepare('SELECT from_status, to_status, actor_type, actor_id FROM task_status_events')
      .all();
    expect(events).toEqual([
      { from_status: 'draft', to_status: 'cancelled', actor_type: 'user', actor_id: USER },
    ]);
  });

  it('is a no-op when the idea is already in that status', async () => {
    seedIdea('idea-1', { status: 'draft' });
    const result = await applyIdeaStatusTransition(ctx, {
      projectId: PROJECT,
      ideaId: 'idea-1',
      status: 'draft',
    });
    expect(result.changed).toBe(false);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM task_status_events').get()).toEqual({ n: 0 });
  });

  it('refuses a transition the table does not allow, and changes nothing', async () => {
    seedIdea('idea-1', { status: 'completed' });
    await expect(
      applyIdeaStatusTransition(ctx, {
        projectId: PROJECT,
        ideaId: 'idea-1',
        status: 'cancelled',
      })
    ).rejects.toThrow(OperationError);
    expect(readIdea('idea-1')?.status).toBe('completed');
  });

  // Attack case: a real idea id, addressed through a project the caller is scoped to.
  it('will not touch an idea from another project', async () => {
    seedIdea('victim', { projectId: OTHER_PROJECT });
    await expect(
      applyIdeaStatusTransition(ctx, {
        projectId: PROJECT,
        ideaId: 'victim',
        status: 'completed',
      })
    ).rejects.toThrow(/Idea not found in this project/);
    expect(readIdea('victim')?.status).toBe('draft');
  });

  // Owner control: the same fixture must still work for the project that owns it, or the
  // attack assertion above is also satisfied by the operation being broken outright.
  it('does change that idea for its own project', async () => {
    seedIdea('victim', { projectId: OTHER_PROJECT });
    await applyIdeaStatusTransition(ctx, {
      projectId: OTHER_PROJECT,
      ideaId: 'victim',
      status: 'completed',
    });
    expect(readIdea('victim')?.status).toBe('completed');
  });

  it('will not touch a task that is not an idea', async () => {
    // An ordinary task: the flag is off AND it is not a draft, so it fails both halves of the
    // shared idea predicate.
    seedIdea('plain-task', { isIdea: 0, status: 'completed' });
    await expect(
      applyIdeaStatusTransition(ctx, {
        projectId: PROJECT,
        ideaId: 'plain-task',
        status: 'draft',
      })
    ).rejects.toThrow(/Idea not found in this project/);
    expect(readIdea('plain-task')?.status).toBe('completed');
  });

  it('requires an idea id', async () => {
    await expect(
      applyIdeaStatusTransition(ctx, { projectId: PROJECT, ideaId: '  ', status: 'completed' })
    ).rejects.toThrow('ideaId is required');
  });

  describe('acknowledgeIdeaMerge ("Keep open")', () => {
    it('records the answer without moving the idea', async () => {
      seedIdea('idea-1');
      const result = await acknowledgeIdeaMerge(ctx, { projectId: PROJECT, ideaId: 'idea-1' });
      const row = readIdea('idea-1');
      expect(row?.status).toBe('draft');
      expect(row?.idea_merge_ack_at).toBe(result.acknowledgedAt);
    });

    it('will not record an answer for another project', async () => {
      seedIdea('victim', { projectId: OTHER_PROJECT });
      await expect(
        acknowledgeIdeaMerge(ctx, { projectId: PROJECT, ideaId: 'victim' })
      ).rejects.toThrow(/Idea not found in this project/);
      expect(readIdea('victim')?.idea_merge_ack_at).toBeNull();
    });

    it('does record it for the project that owns the idea', async () => {
      seedIdea('victim', { projectId: OTHER_PROJECT });
      await acknowledgeIdeaMerge(ctx, { projectId: OTHER_PROJECT, ideaId: 'victim' });
      expect(readIdea('victim')?.idea_merge_ack_at).toBeTruthy();
    });
  });

  // The agreement test the task asked for: `update_idea` and the transition operation are
  // the two surfaces a person reaches, and they must answer the same way.
  describe('update_idea and the transition operation agree', () => {
    it.each([
      ['draft', 'completed', true],
      ['draft', 'cancelled', true],
      ['draft', 'ready', true],
      ['ready', 'completed', true],
      ['completed', 'draft', true],
      ['completed', 'cancelled', false],
      ['cancelled', 'completed', false],
    ])('%s → %s is allowed: %s, on both surfaces', async (from, to, allowed) => {
      seedIdea('via-operation', { status: from });
      seedIdea('via-update-idea', { status: from });

      const operation = applyIdeaStatusTransition(ctx, {
        projectId: PROJECT,
        ideaId: 'via-operation',
        status: to,
      });
      const mcp = updateIdea(ctx, {
        projectId: PROJECT,
        ideaId: 'via-update-idea',
        status: to,
      });

      if (allowed) {
        await expect(operation).resolves.toMatchObject({ toStatus: to });
        await expect(mcp).resolves.toMatchObject({ updated: true });
        expect(readIdea('via-operation')?.status).toBe(to);
        expect(readIdea('via-update-idea')?.status).toBe(to);
      } else {
        await expect(operation).rejects.toThrow(OperationError);
        await expect(mcp).rejects.toThrow(OperationError);
        expect(readIdea('via-operation')?.status).toBe(from);
        expect(readIdea('via-update-idea')?.status).toBe(from);
      }
    });
  });

  // Every ordinary task is created in `draft` (`routes/tasks/crud.ts`) and spends the rest of
  // its life in `ready`, `completed` or `cancelled` — the same four statuses an idea uses. So
  // status alone cannot identify an idea, and the flag is the whole predicate. Without it
  // `update_idea` could retitle, reprioritise or reopen any finished task in the project.
  describe('the idea write paths refuse an ordinary task', () => {
    function seedWorkTask(id: string, status: string) {
      sqlite
        .prepare(
          `INSERT INTO tasks (id, project_id, user_id, title, status, is_idea, priority, task_mode,
             dispatch_depth, created_by, created_at, updated_at, triggered_by)
           VALUES (?, ?, ?, 'real work', ?, 0, 0, 'task', 0, ?, '2026-10-20T00:00:00.000Z',
                   '2026-10-20T00:00:00.000Z', 'user')`
        )
        .run(id, PROJECT, USER, status, USER);
    }

    it.each(['draft', 'ready', 'completed', 'cancelled'])(
      'will not let update_idea touch a %s task, and changes nothing',
      async (status) => {
        seedWorkTask('work-1', status);
        await expect(
          updateIdea(ctx, { projectId: PROJECT, ideaId: 'work-1', title: 'hijacked' })
        ).rejects.toThrow(OperationError);
        expect(
          sqlite.prepare('SELECT title, status FROM tasks WHERE id = ?').get('work-1')
        ).toEqual({ title: 'real work', status });
      }
    );

    it.each(['draft', 'completed', 'cancelled'])(
      'will not transition a %s task through the idea table',
      async (status) => {
        seedWorkTask('work-1', status);
        await expect(
          applyIdeaStatusTransition(ctx, {
            projectId: PROJECT,
            ideaId: 'work-1',
            status: 'completed',
          })
        ).rejects.toThrow(OperationError);
        expect(readIdea('work-1')?.status).toBe(status);
      }
    );

    it('will not acknowledge a merge on an ordinary task', async () => {
      seedWorkTask('work-1', 'completed');
      await expect(
        acknowledgeIdeaMerge(ctx, { projectId: PROJECT, ideaId: 'work-1' })
      ).rejects.toThrow(OperationError);
    });

    // The owner control: a real idea in each of the same statuses still updates, so the
    // refusals above cannot pass by these paths being broken outright.
    it.each(['draft', 'ready', 'completed', 'cancelled'])(
      'still lets update_idea retitle a real %s idea',
      async (status) => {
        seedIdea('idea-1', { status });
        await expect(
          updateIdea(ctx, { projectId: PROJECT, ideaId: 'idea-1', title: 'a better title' })
        ).resolves.toMatchObject({ updated: true });
        expect(sqlite.prepare('SELECT title FROM tasks WHERE id = ?').get('idea-1')).toEqual({
          title: 'a better title',
        });
      }
    );
  });
});
