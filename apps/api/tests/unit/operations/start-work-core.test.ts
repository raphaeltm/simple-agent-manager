/**
 * The idea gate and the link write behind Start work.
 *
 * The project scope is a SQL predicate, so it runs against a real SQLite engine with a
 * foreign-project attack case and a same-project owner control (rules 11, 28). A mock
 * whose `.where()` ignores its arguments would pass with the predicate deleted.
 */
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const recordLinkMock = vi.hoisted(() => vi.fn());
vi.mock('../../../src/operations/link-core', () => ({ recordLink: recordLinkMock }));

import type { Env } from '../../../src/env';
import { AppError } from '../../../src/middleware/error';
import { ideaTaskPredicateSql } from '../../../src/operations/idea-identity';
import {
  classifyWorkStartIdea,
  recordWorkStartIdeaLink,
  requireOpenIdeaForWorkStart,
} from '../../../src/operations/start-work-core';

function fixture() {
  const db = new Database(':memory:');
  // `is_idea` is the discriminator now, not `status = 'draft'` (program decision 16). The
  // column is NOT NULL DEFAULT 0 in migration 0207, so the fixture carries it explicitly.
  db.exec(`CREATE TABLE tasks(id TEXT PRIMARY KEY, project_id TEXT, title TEXT, status TEXT,
      is_idea INTEGER NOT NULL DEFAULT 0);
    INSERT INTO tasks VALUES
      ('idea-open','own','Retry failed webhook deliveries','draft',1),
      ('idea-done','own','Shipped already','completed',1),
      ('idea-parked','own','Parked for now','cancelled',1),
      ('task-ordinary','own','An ordinary queued task','queued',0),
      -- The row only the NEW definition excludes. Under the old \`status = 'draft'\` rule this
      -- was indistinguishable from an idea, so Start work would have accepted it.
      ('task-ordinary-draft','own','An ordinary task nobody has dispatched','draft',0),
      -- Ordinary CLOSED tasks. Their status matches an idea's done/parked statuses exactly, so
      -- they are what separates "is this an idea" from "what state is it in".
      ('task-ordinary-done','own','An ordinary task that finished','completed',0),
      ('task-ordinary-cancelled','own','An ordinary task that was cancelled','cancelled',0),
      ('idea-foreign','other','Another project''s idea','draft',1);`);
  const d1 = {
    prepare: (sql: string) => ({
      bind: (...args: unknown[]) => ({
        first: async () => db.prepare(sql).get(...args) ?? null,
      }),
    }),
  } as unknown as D1Database;
  return { db, env: { DATABASE: d1 } as Env };
}

async function statusOf(promise: Promise<unknown>): Promise<number> {
  try {
    await promise;
    return 200;
  } catch (error) {
    if (error instanceof AppError) return error.statusCode;
    throw error;
  }
}

describe('requireOpenIdeaForWorkStart', () => {
  it('resolves an open idea in this project (owner control)', async () => {
    const { db, env } = fixture();
    try {
      await expect(requireOpenIdeaForWorkStart(env, 'own', 'idea-open')).resolves.toEqual({
        ideaId: 'idea-open',
        title: 'Retry failed webhook deliveries',
      });
    } finally {
      db.close();
    }
  });

  it("404s another project's idea without revealing that it exists", async () => {
    const { db, env } = fixture();
    try {
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'idea-foreign'))).toBe(404);
      // Same id, correct project: proves the row is readable and the predicate is what rejects.
      await expect(
        requireOpenIdeaForWorkStart(env, 'other', 'idea-foreign')
      ).resolves.toMatchObject({ ideaId: 'idea-foreign' });
    } finally {
      db.close();
    }
  });

  it('404s an ordinary task, which is not an idea', async () => {
    const { db, env } = fixture();
    try {
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'task-ordinary'))).toBe(404);
    } finally {
      db.close();
    }
  });

  /*
   * The case only the `is_idea` definition excludes. This row is `draft`, so under the old
   * "an idea is a task in draft" rule Start work would have accepted an ordinary undispatched
   * task as an idea — same status, same project, same everything except the flag. It is the
   * discriminating half of the test above, which passes either way because its row is `queued`.
   */
  it('404s an ordinary DRAFT task, which the old status rule would have accepted', async () => {
    const { db, env } = fixture();
    try {
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'task-ordinary-draft'))).toBe(
        404
      );
      // The owner control, so this cannot pass by the gate being broken for everything.
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'idea-open'))).toBe(200);
    } finally {
      db.close();
    }
  });

  /*
   * The disclosure case. `task-ordinary-done` is `completed` in the caller's OWN project, so
   * authorization is not what refuses it — only `is_idea = 0` is. A 409 would answer
   * "That idea is done. Reopen it before starting work on it." for an arbitrary task id,
   * telling the caller both that the row exists and what state it is in. Every other non-idea
   * gets a bare 404 and so must this one.
   */
  it('404s an ordinary CLOSED task without naming its state', async () => {
    const { db, env } = fixture();
    try {
      for (const id of ['task-ordinary-done', 'task-ordinary-cancelled']) {
        expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', id))).toBe(404);
        // The 409 wording must not be reachable from a non-idea at all, not merely a 404 that
        // happens to carry it.
        await expect(requireOpenIdeaForWorkStart(env, 'own', id)).rejects.not.toThrow(
          /Reopen it/i
        );
      }
      /*
       * The owner controls. A real done idea still gets its actionable 409, and an open idea
       * still starts — so the refusal above cannot be the gate having broken for everything,
       * and the fix cannot have been "404 anything that is not draft".
       */
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'idea-done'))).toBe(409);
      await expect(requireOpenIdeaForWorkStart(env, 'own', 'idea-done')).rejects.toThrow(
        /Reopen it/i
      );
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'idea-open'))).toBe(200);
    } finally {
      db.close();
    }
  });

  it('409s a done idea with a message that says what to do', async () => {
    const { db, env } = fixture();
    try {
      await expect(requireOpenIdeaForWorkStart(env, 'own', 'idea-done')).rejects.toThrow(
        /idea is done\. Reopen it/i
      );
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'idea-done'))).toBe(409);
    } finally {
      db.close();
    }
  });

  it('409s a parked idea', async () => {
    const { db, env } = fixture();
    try {
      await expect(requireOpenIdeaForWorkStart(env, 'own', 'idea-parked')).rejects.toThrow(
        /idea is parked\. Reopen it/i
      );
    } finally {
      db.close();
    }
  });

  it('404s an id that does not exist and 400s a blank one', async () => {
    const { db, env } = fixture();
    try {
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', 'nope'))).toBe(404);
      expect(await statusOf(requireOpenIdeaForWorkStart(env, 'own', '   '))).toBe(400);
    } finally {
      db.close();
    }
  });
});

describe('classifyWorkStartIdea', () => {
  /*
   * The whole matrix. Two rows carry the design and neither can be dropped:
   *
   * ('completed', true) — a done idea still reads as an idea, because the predicate is
   * `is_idea = 1`. If openness were inferred from the predicate rather than read off the
   * status, that row would be admitted and a done idea would become startable.
   *
   * ('completed', false) — an ordinary finished task. It shares its status with a done idea,
   * so it is the only row that can tell the two questions apart in the other direction. It
   * must be `not-an-open-idea`, i.e. a non-disclosing 404: `closed` here would answer
   * "That idea is done" for an id the caller only guessed at. This row asserted `closed`
   * while the status test ran first.
   */
  const cases: Array<[string, boolean, string]> = [
    ['draft', true, 'open'],
    ['draft', false, 'not-an-open-idea'],
    ['completed', true, 'closed'],
    ['cancelled', true, 'closed'],
    ['completed', false, 'not-an-open-idea'],
    ['cancelled', false, 'not-an-open-idea'],
    ['in_progress', true, 'not-an-open-idea'],
    ['in_progress', false, 'not-an-open-idea'],
    ['ready', false, 'not-an-open-idea'],
    ['failed', false, 'not-an-open-idea'],
  ];

  for (const [status, isIdea, outcome] of cases) {
    it(`treats status=${status} is_idea=${isIdea} as ${outcome}`, () => {
      expect(classifyWorkStartIdea(status, isIdea).outcome).toBe(outcome);
    });
  }

  it('names the closed state the way a person would say it', () => {
    expect(classifyWorkStartIdea('completed', true)).toEqual({ outcome: 'closed', label: 'done' });
    expect(classifyWorkStartIdea('cancelled', true)).toEqual({
      outcome: 'closed',
      label: 'parked',
    });
  });
});

// `ideaTaskPredicateSql` is T3's (`operations/idea-identity.ts`) and T8 widens it, but it is
// interpolated straight into this module's admission SQL, so its alias guard is covered here —
// it had no test of its own when T7 rebased onto it.
describe('ideaTaskPredicateSql', () => {
  it('qualifies the predicate with the caller supplied alias', () => {
    // Program decision 16: an idea is `is_idea = 1`, not `status = 'draft'`. This assertion
    // pinned the old text; reconciled here because T8 merges after T7 (coordinator, seq 228).
    expect(ideaTaskPredicateSql()).toBe('tasks.is_idea = 1');
    expect(ideaTaskPredicateSql('t')).toBe('t.is_idea = 1');
  });

  it('rejects an alias that is not a plain identifier, so it cannot carry injected SQL', () => {
    expect(() => ideaTaskPredicateSql("t' OR 1=1 --")).toThrow(/Invalid SQL table alias/);
    expect(() => ideaTaskPredicateSql('tasks; DROP TABLE tasks')).toThrow(
      /Invalid SQL table alias/
    );
  });
});

describe('recordWorkStartIdeaLink', () => {
  const env = {} as Env;
  // `mockImplementation` on both, never mixed with `mockResolvedValue`: in vitest 4 a
  // `mockResolvedValue` left in place when the implementation is replaced leaves an
  // unhandled rejected promise behind, which fails the file for the wrong reason.
  beforeEach(() => {
    recordLinkMock.mockReset();
    recordLinkMock.mockImplementation(() => Promise.resolve(undefined));
  });

  it('records works_on for task work', async () => {
    await recordWorkStartIdeaLink(env, 'own', {
      ideaId: 'idea-open',
      sessionId: 'sess-1',
      taskMode: 'task',
    });
    expect(recordLinkMock).toHaveBeenCalledWith(env, 'own', {
      sourceKind: 'session',
      sourceId: 'sess-1',
      targetKind: 'idea',
      targetId: 'idea-open',
      relation: 'works_on',
      origin: 'explicit',
      context: null,
    });
  });

  it('records discusses for a conversation', async () => {
    await recordWorkStartIdeaLink(env, 'own', {
      ideaId: 'idea-open',
      sessionId: 'sess-1',
      taskMode: 'conversation',
    });
    expect(recordLinkMock.mock.calls[0]?.[2]).toMatchObject({ relation: 'discusses' });
  });

  // Not best-effort: the old browser-side link only logged, and a chat that works on an
  // idea without being linked to it is invisible afterwards.
  it('throws a clear error when the link write fails', async () => {
    recordLinkMock.mockImplementation(() => Promise.reject(new Error('DO unavailable')));
    await expect(
      recordWorkStartIdeaLink(env, 'own', {
        ideaId: 'idea-open',
        sessionId: 'sess-1',
        taskMode: 'task',
      })
    ).rejects.toThrow(/Could not link this chat to the idea/);
  });
});
