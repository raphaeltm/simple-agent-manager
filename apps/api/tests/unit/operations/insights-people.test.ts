/**
 * projectPeople (Insights · People) against a real SQL engine. Every section is seeded with a
 * foreign project's rows that would change the answer if a project predicate were missing (rules
 * 11 and 28), beside the owner's rows as the control. Review cycles are written by the real GitHub
 * webhook ingest (`ingestPullRequestWebhook`) from production-shaped payloads (rule 62); reassignment
 * activity rows carry exactly the detail the two writers produce (`reassignTask`,
 * `moveDepartedMemberTasksToTeam`). The real reassign route is exercised end to end in
 * `tests/workers/insights-people-capability.test.ts`.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { projectPeople } from '@simple-agent-manager/operations';
import { waitingItemsStatement } from '@simple-agent-manager/operations/internal/insights-people-sql';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { ingestPullRequestWebhook } from '../../../src/services/github-pull-request-events';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const ago = (ms: number) => NOW - ms;
const isoAgo = (ms: number) => new Date(NOW - ms).toISOString().replace('.000Z', 'Z');

describe('projectPeople', () => {
  let sqlite: Database.Database;
  let env: Env;

  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      ports: createOperationPorts(env),
      requestId: 'test',
      actor: { userId, via: 'web', scopes: new Set(['sam.read']) },
    };
  }

  function ask(id: string, fields: Record<string, string | number | null> = {}): void {
    const row: Record<string, string | number | null> = {
      id,
      project_id: 'p',
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      kind: 'question',
      blocking: 0,
      title: `Title ${id}`,
      status: 'open',
      created_at: ago(DAY),
      updated_at: ago(DAY),
      ...fields,
    };
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO asks (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }

  /** An `ask_activity` row exactly as `reassignTask` / the departed-member handoff write it. */
  function reassigned(
    askId: string,
    detail: {
      fromKind: string;
      fromUserId: string | null;
      toKind: string;
      toUserId: string | null;
      reason?: string;
    },
    at: number,
    projectId = 'p'
  ): void {
    sqlite
      .prepare(
        `INSERT INTO ask_activity (id, ask_id, project_id, actor_kind, actor_id, kind, detail_json, created_at)
         VALUES (?, ?, ?, ?, ?, 'reassigned', ?, ?)`
      )
      .run(
        `act-${askId}-${at}`,
        askId,
        projectId,
        detail.reason ? 'system' : 'user',
        detail.reason ? null : 'owner',
        JSON.stringify(detail),
        at
      );
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    createDeclaredIndexes(sqlite, [schema.pullRequestReviewRequests]);
    sqlite.exec(`
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'),
        ('mate','Mate Person','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO projects (id, name, repository, user_id) VALUES ('p', 'Project', 'acme/app', 'owner'),
        ('foreign', 'Other', 'other/repo', 'outsider');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','mate','member','active'),
        ('foreign','outsider','owner','active'), ('foreign','owner','member','active');
      INSERT INTO tasks (id, project_id, user_id, title, status, task_mode, is_idea, created_at, updated_at) VALUES
        ('src-owner', 'p', 'owner', 'Owner run', 'in_progress', 'task', 0, '2026-11-15T00:00:00Z', '2026-11-15T00:00:00Z');
    `);
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  const people = (userId = 'owner', range = '30d') =>
    projectPeople(ctx(userId), { projectId: 'p', range, nowMs: NOW });

  describe('waiting on', () => {
    beforeEach(() => {
      ask('own-q', { created_at: ago(3 * DAY), blocking: 1 });
      ask('own-task', { kind: 'task', created_at: ago(DAY) });
      ask('mate-q', {
        assignee_user_id: 'mate',
        title: 'Mate private question',
        created_at: ago(5 * DAY),
      });
      // A task the owner's run filed for the colleague: the owner may read and hand it on.
      ask('filed-for-mate', {
        kind: 'task',
        assignee_user_id: 'mate',
        source_task_id: 'src-owner',
        created_at: ago(2 * HOUR),
      });
      ask('team-open', {
        kind: 'task',
        assignee_kind: 'team',
        assignee_user_id: null,
        created_at: ago(2 * DAY),
      });
      ask('team-taken', {
        kind: 'task',
        assignee_kind: 'team',
        assignee_user_id: null,
        claimed_by_user_id: 'mate',
        created_at: ago(4 * HOUR),
      });
      // Not waiting: closed, expired, a system error item.
      ask('own-answered', {
        status: 'answered',
        resolved_at: ago(HOUR),
        resolved_by_user_id: 'owner',
      });
      ask('own-expired', { expires_at: ago(HOUR) });
      ask('own-error', { kind: 'error' });
      // Attack fixture: another project's open items assigned to the same people.
      ask('foreign-q', { project_id: 'foreign', created_at: ago(30 * DAY) });
      ask('foreign-mate', {
        project_id: 'foreign',
        assignee_user_id: 'mate',
        created_at: ago(30 * DAY),
      });
      ask('foreign-team', {
        project_id: 'foreign',
        kind: 'task',
        assignee_kind: 'team',
        assignee_user_id: null,
      });
    });

    it('groups open items by who they wait on, oldest wait first, with the unassigned group', async () => {
      const result = await people();
      expect(result.unavailable).toEqual([]);
      expect(
        result.waiting.groups.map((g) => [g.key, g.kind, g.name, g.you, g.open, g.blocking])
      ).toEqual([
        ['mate', 'person', 'Mate Person', false, 3, 0],
        ['owner', 'person', 'Owner', true, 2, 1],
        ['unassigned', 'unassigned', null, false, 1, 0],
      ]);
      expect(result.waiting.total).toBe(6);
      const mate = result.waiting.groups[0]!;
      expect(mate.oldestAgeMs).toBe(5 * DAY);
      expect(mate.items.map((i) => i.createdAt)).toEqual(
        [5 * DAY, 4 * HOUR, 2 * HOUR].map((ms) => new Date(NOW - ms).toISOString())
      );
    });

    it('never sends the title of an item the viewer could not open in the Inbox', async () => {
      const result = await people('owner');
      const mate = result.waiting.groups.find((g) => g.key === 'mate')!;
      const [privateQ, takenTeam, filed] = mate.items;
      expect(privateQ).toMatchObject({
        ref: null,
        title: null,
        kind: 'question',
        canReassign: false,
      });
      // A team task is readable by every member; one the colleague took waits on them.
      expect(takenTeam).toMatchObject({
        ref: 'ask:team-taken',
        title: 'Title team-taken',
        claimed: true,
      });
      // The owner's run filed it: the filer may read it (Inbox rule).
      expect(filed).toMatchObject({ ref: 'ask:filed-for-mate', title: 'Title filed-for-mate' });
      expect(JSON.stringify(result)).not.toContain('Mate private question');

      // Control: the colleague sees their own question's title.
      const asMate = await people('mate');
      const own = asMate.waiting.groups.find((g) => g.key === 'mate')!;
      expect(own.you).toBe(true);
      expect(own.items[0]).toMatchObject({ ref: 'ask:mate-q', title: 'Mate private question' });
      // …and not the owner's question.
      const ownerGroup = asMate.waiting.groups.find((g) => g.key === 'owner')!;
      expect(ownerGroup.items.every((i) => i.title === null || i.kind === 'task')).toBe(true);
      expect(ownerGroup.items.find((i) => i.kind === 'question')).toMatchObject({ title: null });
    });

    it('never selects an unreadable title out of D1 (the SQL layer alone)', () => {
      const statement = waitingItemsStatement('p', NOW, 'owner', ['owner', 'admin', 'member'], 10);
      const rows = sqlite.prepare(statement.sql).all(...statement.binds) as Array<{
        id: string;
        title: string | null;
      }>;
      expect(rows.find((row) => row.id === 'mate-q')?.title).toBeNull();
      // Control: a readable title is selected.
      expect(rows.find((row) => row.id === 'own-q')?.title).toBe('Title own-q');
    });

    it('offers reassign exactly where the Inbox task path would allow it', async () => {
      const result = await people('owner');
      const flags = Object.fromEntries(
        result.waiting.groups
          .flatMap((g) => g.items)
          .filter((i) => i.ref)
          .map((i) => [i.ref, i.canReassign])
      );
      expect(flags).toEqual({
        'ask:own-q': false, // questions have no reassign path
        'ask:own-task': true, // assignee
        'ask:filed-for-mate': true, // filer
        'ask:team-open': true, // nobody took it
        'ask:team-taken': false, // the colleague took it
      });
      // A member without write access is never offered it.
      sqlite.exec(
        `UPDATE project_members SET role = 'viewer' WHERE project_id = 'p' AND user_id = 'owner'`
      );
      const asViewer = await people('owner');
      expect(asViewer.waiting.groups.flatMap((g) => g.items).some((i) => i.canReassign)).toBe(
        false
      );
    });

    it('ignores another project’s items (attack) while counting this project’s (control)', async () => {
      const result = await people();
      const keys = result.waiting.groups.flatMap((g) => g.items.map((i) => i.ref ?? i.createdAt));
      expect(keys).not.toContain('ask:foreign-q');
      expect(result.waiting.groups.find((g) => g.key === 'owner')?.oldestAgeMs).toBe(3 * DAY);
      // The foreign project sees its own items, not ours.
      const foreign = await projectPeople(ctx('outsider'), {
        projectId: 'foreign',
        range: '30d',
        nowMs: NOW,
      });
      expect(foreign.waiting.total).toBe(3);
    });

    it('lists at most `listed` items per person but counts them all', async () => {
      for (let i = 0; i < 12; i += 1) ask(`bulk-${i}`, { created_at: ago(10 * DAY + i * HOUR) });
      const owner = (await people()).waiting.groups.find((g) => g.key === 'owner')!;
      expect(owner.open).toBe(14);
      expect(owner.items).toHaveLength(10);
      // Oldest first: the 12 bulk items are older than the owner's two.
      expect(owner.items[0]?.ref).toBe('ask:bulk-11');
    });

    it('skips a malformed row and keeps the rest (rule 50)', async () => {
      ask('bad-kind', { kind: 'mystery', assignee_user_id: 'mate' }); // filtered by kind in SQL
      sqlite.prepare(`UPDATE asks SET created_at = 'not-a-time' WHERE id = 'filed-for-mate'`).run();
      const result = await people();
      const mate = result.waiting.groups.find((g) => g.key === 'mate')!;
      expect(mate.items.map((i) => i.ref)).not.toContain('ask:filed-for-mate');
      expect(mate.items.map((i) => i.ref)).toContain('ask:team-taken');
      expect(result.unavailable).toEqual([]);
    });
  });

  describe('review pickup', () => {
    const pr = (number: number, author = 'agent-bot') => ({
      number,
      html_url: `https://github.com/acme/app/pull/${number}`,
      user: { login: author },
    });
    const ingest = (event: string, payload: Record<string, unknown>) =>
      ingestPullRequestWebhook(env, event, {
        repository: { id: 91, full_name: 'acme/app' },
        ...payload,
      });
    const request = (number: number, reviewer: string, msAgo: number) =>
      ingest('pull_request', {
        action: 'review_requested',
        pull_request: { ...pr(number), updated_at: isoAgo(msAgo) },
        requested_reviewer: { login: reviewer, type: 'User' },
      });
    const review = (number: number, reviewer: string, msAgo: number, author = 'agent-bot') =>
      ingest('pull_request_review', {
        action: 'submitted',
        pull_request: pr(number, author),
        review: {
          user: { login: reviewer, type: 'User' },
          submitted_at: isoAgo(msAgo),
          state: 'approved',
        },
      });

    it('reads "not recorded" until a request is recorded', async () => {
      const result = await people();
      expect(result.reviewPickup).toEqual({
        state: 'not_recorded',
        waiting: 0,
        recordedSince: null,
      });
    });

    it('reports median and p90 from webhook-recorded requests, per project', async () => {
      // Four picked-up requests: 1h, 2h, 3h, 10h.
      await request(1, 'Alice', 20 * HOUR);
      await review(1, 'alice', 19 * HOUR);
      await request(2, 'bob', 20 * HOUR);
      await review(2, 'bob', 18 * HOUR);
      await request(3, 'alice', 20 * HOUR);
      await review(3, 'alice', 17 * HOUR);
      await request(4, 'carol', 20 * HOUR);
      await review(4, 'carol', 10 * HOUR);
      // Still waiting; removed (not a pickup); requested before the range.
      await request(5, 'dave', 5 * HOUR);
      await request(6, 'erin', 6 * HOUR);
      await ingest('pull_request', {
        action: 'review_request_removed',
        pull_request: { ...pr(6), updated_at: isoAgo(5 * HOUR) },
        requested_reviewer: { login: 'erin', type: 'User' },
      });
      await request(7, 'frank', 40 * DAY);
      await review(7, 'frank', 39 * DAY);
      // Attack fixture: another project's cycle with a huge pickup inside the range.
      sqlite.exec(`INSERT INTO pull_request_review_requests
        (project_id, repository, pr_number, reviewer_kind, reviewer_key, requested_at, first_review_at)
        VALUES ('foreign', 'other/repo', 1, 'user', 'zed', '${new Date(ago(25 * DAY)).toISOString()}',
          '${new Date(ago(HOUR)).toISOString()}')`);

      const result = await people();
      expect(result.reviewPickup).toEqual({
        state: 'recorded',
        samples: 4,
        medianMs: 2 * HOUR,
        p90Ms: 10 * HOUR,
        waiting: 1,
        recordedSince: new Date(ago(40 * DAY)).toISOString(),
        truncated: false,
      });
    });

    it('a redelivered request or review changes nothing; a re-request after a review is a new cycle', async () => {
      await request(1, 'alice', 10 * HOUR);
      await request(1, 'alice', 10 * HOUR); // redelivery
      await review(1, 'alice', 9 * HOUR);
      await review(1, 'alice', 9 * HOUR); // redelivery
      await request(1, 'alice', 10 * HOUR); // late redelivery of the first request
      await request(1, 'alice', 4 * HOUR); // asked again after changes
      await review(1, 'alice', HOUR);
      const rows = sqlite
        .prepare(
          'SELECT requested_at, first_review_at FROM pull_request_review_requests ORDER BY requested_at'
        )
        .all();
      expect(rows).toHaveLength(2);
      const result = await people();
      expect(result.reviewPickup).toMatchObject({ state: 'recorded', samples: 2, waiting: 0 });
    });

    it('a team request is picked up by anyone but the author; bots are skipped', async () => {
      await ingest('pull_request', {
        action: 'review_requested',
        pull_request: { ...pr(9, 'raphael'), updated_at: isoAgo(6 * HOUR) },
        requested_team: { slug: 'Core', name: 'Core' },
      });
      await ingest('pull_request', {
        action: 'review_requested',
        pull_request: { ...pr(9, 'raphael'), updated_at: isoAgo(6 * HOUR) },
        requested_reviewer: { login: 'Copilot', type: 'Bot' },
      });
      // The author's own comment and a bot review answer nobody's request.
      await review(9, 'raphael', 5 * HOUR, 'raphael');
      await ingest('pull_request_review', {
        action: 'submitted',
        pull_request: pr(9, 'raphael'),
        review: {
          user: { login: 'coderabbitai[bot]', type: 'Bot' },
          submitted_at: isoAgo(5 * HOUR),
        },
      });
      let result = await people();
      expect(result.reviewPickup).toMatchObject({ state: 'not_recorded', waiting: 1 });
      await review(9, 'mate-login', 3 * HOUR, 'raphael');
      result = await people();
      expect(result.reviewPickup).toMatchObject({
        state: 'recorded',
        samples: 1,
        medianMs: 3 * HOUR,
      });
    });

    it('skips a malformed cycle row', async () => {
      await request(1, 'alice', 10 * HOUR);
      await review(1, 'alice', 9 * HOUR);
      sqlite.exec(`INSERT INTO pull_request_review_requests
        (project_id, repository, pr_number, reviewer_kind, reviewer_key, requested_at, first_review_at)
        VALUES ('p', 'acme/app', 2, 'user', 'x', '2026-11-16Tgarbage', 'also garbage')`);
      const result = await people();
      expect(result.reviewPickup).toMatchObject({ state: 'recorded', samples: 1, medianMs: HOUR });
    });
  });

  describe('answered by the first person asked', () => {
    it('counts only asks first given to one person, and only their own answers with no handoff', async () => {
      // First person: answered by the owner, never handed on.
      ask('q1', { status: 'answered', resolved_by_user_id: 'owner', resolved_at: ago(DAY) });
      ask('t-done', {
        kind: 'task',
        status: 'done',
        resolved_by_user_id: 'owner',
        resolved_at: ago(DAY),
      });
      // Handed on owner → mate, done by mate: not the first person.
      ask('t1', {
        kind: 'task',
        assignee_user_id: 'mate',
        status: 'done',
        resolved_by_user_id: 'mate',
        resolved_at: ago(DAY),
      });
      reassigned(
        't1',
        { fromKind: 'user', fromUserId: 'owner', toKind: 'user', toUserId: 'mate' },
        ago(2 * DAY)
      );
      // First asked the team, then given to the owner: no first person, so not counted.
      ask('t2', {
        kind: 'task',
        status: 'done',
        resolved_by_user_id: 'owner',
        resolved_at: ago(DAY),
      });
      reassigned(
        't2',
        { fromKind: 'team', fromUserId: null, toKind: 'user', toUserId: 'owner' },
        ago(2 * DAY)
      );
      // The colleague left; their task went to the team and the owner finished it.
      ask('t3', {
        kind: 'task',
        assignee_kind: 'team',
        assignee_user_id: null,
        status: 'done',
        resolved_by_user_id: 'owner',
        resolved_at: ago(DAY),
      });
      reassigned(
        't3',
        {
          fromKind: 'user',
          fromUserId: 'mate',
          toKind: 'team',
          toUserId: null,
          reason: 'member_left',
        },
        ago(2 * DAY)
      );
      // Not counted: still open, archived, expired, a system error, closed before the range.
      ask('open', {});
      ask('archived', { status: 'archived', resolved_by_user_id: 'owner', resolved_at: ago(DAY) });
      ask('expired', { status: 'expired', resolved_at: ago(DAY) });
      ask('err', {
        kind: 'error',
        status: 'done',
        resolved_by_user_id: 'owner',
        resolved_at: ago(DAY),
      });
      ask('old', { status: 'answered', resolved_by_user_id: 'owner', resolved_at: ago(60 * DAY) });
      // Attack fixture: another project's answered asks.
      for (let i = 0; i < 5; i += 1)
        ask(`foreign-${i}`, {
          project_id: 'foreign',
          status: 'answered',
          resolved_by_user_id: 'owner',
          resolved_at: ago(DAY),
        });
      // A reassignment row of ours recorded under another project id must not apply to t-done.
      reassigned(
        't-done',
        { fromKind: 'user', fromUserId: 'owner', toKind: 'user', toUserId: 'mate' },
        ago(2 * DAY),
        'foreign'
      );

      const result = await people();
      expect(result.firstPerson).toEqual({ closed: 4, firstPerson: 2, share: 0.5 });
    });

    it('is null, not zero, when nothing closed', async () => {
      expect((await people()).firstPerson).toEqual({ closed: 0, firstPerson: 0, share: null });
    });
  });

  it('rejects an unknown range and a non-member', async () => {
    await expect(people('owner', '365d')).rejects.toMatchObject({ code: 'invalid_input' });
    await expect(people('outsider')).rejects.toBeTruthy();
    await expect(people('owner')).resolves.toBeTruthy(); // owner control
  });

  it('stays within its round-trip budget', async () => {
    const real = env.DATABASE;
    let trips = 0;
    const wrap = <T extends Record<string, unknown>>(statement: T): T => ({
      ...statement,
      all: async (...a: unknown[]) => {
        trips += 1;
        return (statement.all as (...x: unknown[]) => unknown)(...a);
      },
      first: async (...a: unknown[]) => {
        trips += 1;
        return (statement.first as (...x: unknown[]) => unknown)(...a);
      },
      run: async (...a: unknown[]) => {
        trips += 1;
        return (statement.run as (...x: unknown[]) => unknown)(...a);
      },
      raw: async (...a: unknown[]) => {
        trips += 1;
        return (statement.raw as (...x: unknown[]) => unknown)(...a);
      },
    });
    env = {
      ...env,
      DATABASE: {
        ...real,
        prepare: (sql: string) => {
          const statement = real.prepare(sql) as unknown as Record<string, unknown>;
          return {
            ...wrap(statement),
            bind: (...params: unknown[]) =>
              wrap((statement.bind as (...p: unknown[]) => Record<string, unknown>)(...params)),
          };
        },
        batch: async (statements: unknown[]) => {
          trips += 1;
          return (real.batch as (s: unknown[]) => unknown)(statements);
        },
      },
    } as unknown as Env;
    for (let i = 0; i < 40; i += 1)
      ask(`busy-${i}`, {
        assignee_user_id: i % 2 ? 'owner' : 'mate',
        kind: i % 3 ? 'question' : 'task',
      });
    await people(); // warm the settings cache
    trips = 0;
    const result = await people();
    expect(result.waiting.total).toBe(40);
    // Rule 60 budget for this read is 4 (Insights spec). Measured: membership and the batch.
    expect(trips).toBeLessThanOrEqual(3);
    expect(trips).toBe(2);
  });
});
