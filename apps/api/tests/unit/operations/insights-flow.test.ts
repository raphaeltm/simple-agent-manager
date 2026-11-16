/**
 * projectFlow (Insights · Flow) against a real SQL engine. Every number is a SQL aggregate scoped
 * by project, so each section seeds a foreign project's rows beside the owner's: rows that would
 * change a count if a project predicate or a join's project condition were missing (rules 11 and
 * 28). The ProjectData idea snapshot is an external boundary and is mocked.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { projectFlow } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ snapshots: vi.fn() }));
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getIdeaWorkSnapshots: mocks.snapshots,
}));

const NOW = Date.parse('2026-11-16T12:00:00.000Z');
const DAY = 86_400_000;
const HOUR = 3_600_000;
const iso = (msAgo: number) => new Date(NOW - msAgo).toISOString();
const daysAgo = (days: number) => iso(days * DAY);
const prUrl = (n: number) => `https://github.com/acme/app/pull/${n}`;
const sha = (c: string) => c.repeat(40);

describe('projectFlow', () => {
  let sqlite: Database.Database;
  let env: Env;
  /** Idea id → pull request URLs the ProjectData link store records for it. */
  let ideaPullRequests: Record<string, string[]>;

  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      ports: createOperationPorts(env),
      requestId: 'test',
      actor: { userId, via: 'web', scopes: new Set(['sam.read']) },
    };
  }

  function insert(table: string, row: Record<string, string | number | null>): void {
    const columns = Object.keys(row);
    sqlite
      .prepare(
        `INSERT INTO ${table} (${columns.join(',')}) VALUES (${columns.map(() => '?').join(',')})`
      )
      .run(...Object.values(row));
  }

  function run(id: string, fields: Record<string, string | number | null> = {}): void {
    insert('tasks', {
      id,
      project_id: 'p',
      user_id: 'owner',
      title: `Run ${id}`,
      status: 'completed',
      task_mode: 'task',
      // Production shape: migration 0207 makes is_idea NOT NULL DEFAULT 0.
      is_idea: 0,
      created_at: daysAgo(6),
      updated_at: daysAgo(5),
      completed_at: daysAgo(5),
      ...fields,
    });
  }

  function idea(id: string, fields: Record<string, string | number | null> = {}): void {
    insert('tasks', {
      id,
      project_id: 'p',
      user_id: 'owner',
      title: `Idea ${id}`,
      status: 'draft',
      is_idea: 1,
      created_at: daysAgo(10),
      updated_at: daysAgo(1),
      ...fields,
    });
  }

  function pullRequest(number: number, fields: Record<string, string | number | null> = {}): void {
    insert('pull_requests', {
      id: `pr-${fields.project_id ?? 'p'}-${number}`,
      project_id: 'p',
      repository: 'acme/app',
      number,
      url: prUrl(number),
      state: 'open',
      created_at: daysAgo(6),
      updated_at: daysAgo(1),
      // Production shape: every snapshot writer stamps it, and stored state is only read once set.
      last_synced_at: daysAgo(1),
      ...fields,
    });
  }

  function head(number: number, headSha: string, fields: Record<string, string | number> = {}) {
    insert('pull_request_heads', {
      project_id: 'p',
      repository: 'acme/app',
      pr_number: number,
      head_sha: headSha,
      first_seen_at: daysAgo(6),
      from_open: 1,
      ...fields,
    });
  }

  function check(headSha: string, name: string, fields: Record<string, string | null> = {}) {
    insert('pull_request_checks', {
      project_id: 'p',
      repository: 'acme/app',
      head_sha: headSha,
      check_key: `check_run:12:${name}`,
      state: 'success',
      updated_at: daysAgo(5),
      first_failed_at: null,
      ...fields,
    });
  }

  function ask(id: string, fields: Record<string, string | number | null>): void {
    insert('asks', {
      id,
      project_id: 'p',
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      kind: 'question',
      title: `Ask ${id}`,
      status: 'answered',
      created_at: NOW - 2 * HOUR,
      updated_at: NOW,
      ...fields,
    });
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app'), ('foreign', 'Other', 'acme/app');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('foreign','outsider','owner','active');
    `);
    ideaPullRequests = {};
    mocks.snapshots.mockImplementation(async (_env: unknown, _projectId: string, ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            ideaId: id,
            sessions: [],
            needsInput: [],
            fileIds: [],
            pullRequestUrls: ideaPullRequests[id] ?? [],
            updates: 0,
            truncated: { sessions: false, files: false, pullRequests: false },
          },
        ])
      )
    );
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('counts runs by outcome and derives why the others stopped, never from another project', async () => {
    pullRequest(1, { state: 'merged', merged_at: daysAgo(5) });
    pullRequest(2, { state: 'closed', closed_at: daysAgo(4) });
    pullRequest(3, { state: 'open', checks_state: 'failure' });
    pullRequest(4, { state: 'merged', merged_at: daysAgo(3) });
    run('merged', { output_pr_url: prUrl(1) });
    run('closed', { output_pr_url: prUrl(2) });
    run('ci', { output_pr_url: prUrl(3) });
    run('assoc');
    insert('task_pull_request_associations', {
      task_id: 'assoc',
      project_id: 'p',
      pr_url: prUrl(4),
      disposition: 'owned',
      reason: 'test',
      recorded_by_user_id: 'owner',
      created_at: daysAgo(3),
    });
    run('capacity', { status: 'failed', error_message: 'No capacity for any permitted offering' });
    run('limit', {
      status: 'cancelled',
      error_message: 'Stopped by parent: Provider five-hour limit explicitly hit',
    });
    run('coordinator', { status: 'cancelled', error_message: 'Stopped by parent: duplicate' });
    run('waiting', { status: 'in_progress', completed_at: null, created_at: daysAgo(1) });
    insert('session_summaries', {
      id: 's-waiting',
      project_id: 'p',
      user_id: 'owner',
      status: 'active',
      task_id: 'waiting',
      started_at: NOW - DAY,
      attention_json: JSON.stringify({ markerId: 'm1' }),
      updated_at: NOW,
    });
    run('working', { status: 'in_progress', completed_at: null, created_at: daysAgo(1) });
    run('conversation', { task_mode: 'conversation', status: 'cancelled' });
    run('old', { status: 'failed', error_message: 'No capacity', completed_at: daysAgo(40) });

    // Attacks, each beside the owner control above:
    // a foreign project's PR row with the URL our run names cannot make it merged;
    pullRequest(9, { project_id: 'foreign', state: 'merged', merged_at: daysAgo(2) });
    run('foreign-url', { output_pr_url: prUrl(9) });
    // an association recorded under another project cannot make our run merged;
    run('assoc-foreign');
    insert('task_pull_request_associations', {
      task_id: 'assoc-foreign',
      project_id: 'foreign',
      pr_url: prUrl(4),
      disposition: 'owned',
      reason: 'test',
      recorded_by_user_id: 'outsider',
      created_at: daysAgo(3),
    });
    // another project's attention marker and ask cannot put our working run on hold;
    insert('session_summaries', {
      id: 's-foreign',
      project_id: 'foreign',
      user_id: 'outsider',
      status: 'active',
      task_id: 'working',
      started_at: NOW - DAY,
      attention_json: JSON.stringify({ markerId: 'm2' }),
      updated_at: NOW,
    });
    ask('foreign-ask', { project_id: 'foreign', source_task_id: 'working', status: 'open' });
    // and another project's failed runs are not ours.
    run('foreign-run', {
      project_id: 'foreign',
      user_id: 'outsider',
      status: 'failed',
      error_message: 'No capacity',
    });

    const result = await projectFlow(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });

    const totals = result.runs.buckets.reduce(
      (sum, b) => ({
        merged: sum.merged + b.merged,
        closed: sum.closed + b.closed,
        failed: sum.failed + b.failed,
      }),
      { merged: 0, closed: 0, failed: 0 }
    );
    expect(totals).toEqual({ merged: 2, closed: 1, failed: 1 });
    expect(result.runs.other).toEqual({ stopped: 2, prOpen: 1, noPullRequest: 2 });
    expect(result.runs.bucket).toBe('week');
    // Every week of the range is present, quiet ones as zero, Monday-aligned.
    expect(result.runs.buckets.length).toBeGreaterThanOrEqual(5);
    for (const b of result.runs.buckets) expect(new Date(b.start).getUTCDay()).toBe(1);

    expect(Object.fromEntries(result.stopReasons.map((r) => [r.reason, r.count]))).toEqual({
      ci_failing: 1,
      no_machine: 1,
      pr_closed: 1,
      usage_limit: 1,
      stopped_by_coordinator: 1,
      waiting_on_person: 1,
    });
    expect(result.unavailable).toEqual([]);
  });

  it('measures CI first try only on recorded opening commits and lists flaky checks', async () => {
    pullRequest(1, { state: 'merged', merged_at: daysAgo(4), head_sha: sha('b') });
    pullRequest(4, { state: 'merged', merged_at: daysAgo(3), head_sha: sha('d') });
    pullRequest(3, { state: 'open', head_sha: sha('c') });
    pullRequest(2, { state: 'open', head_sha: sha('e') });
    // #1 opened at a, passed everything, then pushed b: passed first try.
    head(1, sha('a'));
    head(1, sha('b'), { from_open: 0, first_seen_at: daysAgo(5) });
    check(sha('a'), 'build');
    check(sha('a'), 'unit tests');
    // #4 opened at d; unit tests failed and a rerun passed: not first try, and flaky.
    head(4, sha('d'));
    check(sha('d'), 'build');
    check(sha('d'), 'unit tests', { first_failed_at: daysAgo(5) });
    // #3 opened at c, one check passed and one still running on the same commit: undecided.
    head(3, sha('c'));
    check(sha('c'), 'build', { state: 'pending' });
    check(sha('c'), 'lint');
    // #2 was known before its opening commit was recorded: not recorded at all.
    head(2, sha('e'), { from_open: 0 });
    check(sha('e'), 'build', { state: 'failure', first_failed_at: daysAgo(2) });
    // Another flip of the same check on an unrelated commit.
    check(sha('f'), 'unit tests', { first_failed_at: daysAgo(2) });

    // Attacks: a foreign project's failing check on our opening commit must not fail #1, its own
    // recorded opening commit must not be counted, and its flaky check must not be listed.
    insert('pull_request_checks', {
      project_id: 'foreign',
      repository: 'acme/app',
      head_sha: sha('a'),
      check_key: 'check_run:12:build',
      state: 'failure',
      updated_at: daysAgo(5),
      first_failed_at: daysAgo(5),
    });
    head(8, sha('9'), { project_id: 'foreign' });
    // A foreign project's #3 has merged; ours has not, so ours is still undecided.
    pullRequest(3, { project_id: 'foreign', state: 'merged', merged_at: daysAgo(1) });
    insert('pull_request_checks', {
      project_id: 'foreign',
      repository: 'acme/app',
      head_sha: sha('9'),
      check_key: 'check_run:12:foreign flake',
      state: 'success',
      updated_at: daysAgo(5),
      first_failed_at: daysAgo(5),
    });

    const result = await projectFlow(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });

    expect(result.tiles.ciFirstTry).toMatchObject({ count: 1, of: 2, rate: 0.5, recorded: 3 });
    expect(result.flakyChecks).toEqual({
      items: [{ name: 'unit tests', flips: 2, commits: 3 }],
      total: 1,
    });
    // Two flips of one check outweigh no stop reasons at all.
    expect(result.topBlocker).toEqual({ kind: 'flaky_check', name: 'unit tests', flips: 2 });
  });

  it('says "not recorded" (null) when no pull request in range was seen from its first commit', async () => {
    pullRequest(1, { state: 'merged', merged_at: daysAgo(2), head_sha: sha('a') });
    check(sha('a'), 'build');
    const result = await projectFlow(ctx(), { projectId: 'p', range: '7d', nowMs: NOW });
    expect(result.tiles.ciFirstTry).toEqual({
      count: 0,
      of: 0,
      rate: null,
      previousRate: null,
      recorded: 0,
    });
    expect(result.runs.bucket).toBe('day');
    expect(result.runs.buckets).toHaveLength(8);
  });

  it('counts merges and rework by branch or by idea, per period, scoped to the project', async () => {
    // Current period: #1 (branch feat-a reused by #5), #4 (no follow-up), #6 (idea I1 → #7).
    pullRequest(1, { state: 'merged', merged_at: daysAgo(9), head_ref: 'feat-a' });
    pullRequest(5, { created_at: daysAgo(7), head_ref: 'feat-a' });
    pullRequest(4, { state: 'merged', merged_at: daysAgo(3), head_ref: 'feat-b' });
    pullRequest(6, { state: 'merged', merged_at: daysAgo(4), head_ref: 'feat-c' });
    pullRequest(7, { created_at: daysAgo(3), head_ref: 'feat-d' });
    // Previous period: #10 merged with no follow-up; #11 opened on its branch 10 days later is
    // outside the 7-day window.
    pullRequest(10, { state: 'merged', merged_at: daysAgo(45), head_ref: 'feat-e' });
    pullRequest(11, { created_at: daysAgo(35), head_ref: 'feat-e' });
    idea('I1');
    ideaPullRequests.I1 = [prUrl(6), prUrl(7)];
    // Attacks: a foreign project's merge is not ours, and its PR on our branch is not a follow-up.
    pullRequest(1, { project_id: 'foreign', state: 'merged', merged_at: daysAgo(2) });
    pullRequest(12, { project_id: 'foreign', created_at: daysAgo(2), head_ref: 'feat-b' });

    const result = await projectFlow(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });

    expect(result.merged).toEqual({ count: 3, previous: 1 });
    expect(result.tiles.rework).toEqual({
      count: 2,
      of: 3,
      rate: 2 / 3,
      previousRate: 0,
      windowDays: 7,
    });
  });

  it('measures idea to merged, lists ideas waiting longest, and medians ask waits', async () => {
    pullRequest(6, { state: 'merged', merged_at: daysAgo(4) });
    idea('I1', { created_at: daysAgo(10) });
    ideaPullRequests.I1 = [prUrl(6)];
    idea('I2', { created_at: daysAgo(20), updated_at: daysAgo(20) });
    idea('I3', { created_at: daysAgo(2) });
    idea('I-old', { created_at: daysAgo(400), updated_at: daysAgo(400) });
    idea('I-done', { status: 'completed', created_at: daysAgo(15) });
    // Attack: a foreign project's old open idea does not wait in our list.
    insert('tasks', {
      id: 'I-foreign',
      project_id: 'foreign',
      user_id: 'outsider',
      title: 'Foreign idea',
      status: 'draft',
      is_idea: 1,
      created_at: daysAgo(25),
      updated_at: daysAgo(1),
    });
    ask('a1', { created_at: NOW - 2 * HOUR, resolved_at: NOW - 90 * 60_000 }); // 30 min
    ask('a2', { created_at: NOW - HOUR, status: 'open', resolved_at: null }); // 60 min, still open
    ask('a3', { created_at: NOW - 3 * HOUR, resolved_at: NOW - 170 * 60_000 }); // 10 min
    ask('a-foreign', {
      project_id: 'foreign',
      created_at: NOW - 2 * DAY,
      resolved_at: NOW - HOUR,
    });

    const result = await projectFlow(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });

    expect(result.tiles.ideaToMerged).toMatchObject({ medianMs: 6 * DAY, count: 1 });
    expect(result.tiles.ideaToMerged.sampled).toEqual({ ideas: 4, cap: 100, truncated: false });
    expect(result.waitingIdeas.items.map((i) => i.ideaId)).toEqual(['I2', 'I1', 'I3']);
    expect(result.waitingIdeas.total).toBe(3);
    expect(result.waitingIdeas.items[1]).toMatchObject({ state: 'merged' });
    expect(result.waitingIdeas.items[0]).toMatchObject({ state: 'not-started', chats: 0 });
    expect(result.tiles.waitingOnPerson).toEqual({
      medianMs: 30 * 60_000,
      previousMedianMs: null,
      count: 3,
    });
  });

  it('refuses a non-member, a foreign project and an unknown range', async () => {
    await expect(projectFlow(ctx('outsider'), { projectId: 'p', nowMs: NOW })).rejects.toThrow();
    await expect(
      projectFlow(ctx(), { projectId: 'p', range: '365d', nowMs: NOW })
    ).rejects.toMatchObject({ code: 'invalid_input' });
    // Owner control: the default range works for a member.
    const result = await projectFlow(ctx(), { projectId: 'p', nowMs: NOW });
    expect(result.range).toBe('30d');
  });

  it('skips a malformed idea row without failing the page', async () => {
    idea('good', { created_at: daysAgo(3) });
    // A row the schema rejects (a title that is not text) is skipped, the good one is kept.
    sqlite
      .prepare(
        `INSERT INTO tasks (id, project_id, user_id, title, status, is_idea, created_at, updated_at)
         VALUES ('bad', 'p', 'owner', ?, 'draft', 1, ?, ?)`
      )
      .run(Buffer.from('x'), daysAgo(4), daysAgo(1));
    const result = await projectFlow(ctx(), { projectId: 'p', range: '30d', nowMs: NOW });
    expect(result.waitingIdeas.items.map((i) => i.ideaId)).toEqual(['good']);
  });
});
