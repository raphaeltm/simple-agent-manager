/**
 * projectOverviewGet against a real SQL engine. "Running" is a SQL predicate over the D1 chat
 * index and the task table, and the project scope is a join condition, so a foreign project's
 * rows are seeded beside the owner's and must never appear (rule 11, rule 28 section 5). The
 * ProjectData idea snapshot is an external boundary and is mocked.
 */
import type { OperationContext } from '@simple-agent-manager/operations';
import { projectOverviewGet } from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import {
  createAllSchemaTables,
  createDeclaredIndexes,
  createSqliteD1,
} from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({ snapshots: vi.fn() }));
vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getIdeaWorkSnapshots: mocks.snapshots,
}));

const NOW = 1_794_000_000_000;
const HOUR = 3_600_000;

describe('projectOverviewGet', () => {
  let sqlite: Database.Database;
  let env: Env;

  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      ports: createOperationPorts(env),
      requestId: 'test',
      actor: { userId, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
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

  function task(id: string, fields: Record<string, string | number | null> = {}): void {
    insert('tasks', {
      id,
      project_id: 'p',
      user_id: 'owner',
      title: `Task ${id}`,
      status: 'in_progress',
      execution_step: 'running',
      agent_profile_hint: 'profile-build',
      created_at: '2026-11-16T00:00:00.000Z',
      updated_at: '2026-11-16T00:00:00.000Z',
      ...fields,
    });
  }

  function chat(id: string, fields: Record<string, string | number | null> = {}): void {
    insert('session_summaries', {
      id,
      project_id: 'p',
      user_id: 'owner',
      status: 'active',
      topic: `Chat ${id}`,
      task_id: `task-${id}`,
      message_count: 3,
      started_at: NOW - 3_600_000,
      created_at: NOW - 3_600_000,
      last_message_at: NOW - 60_000,
      agent_completed_at: null,
      attention_json: null,
      created_by_user_id: 'owner',
      updated_at: NOW,
      ...fields,
    });
  }

  /** A chat and its task, the way every chat is task-backed. */
  function running(
    id: string,
    chatFields: Record<string, string | number | null> = {},
    taskFields: Record<string, string | number | null> = {}
  ): void {
    task(`task-${id}`, { chat_session_id: id, ...taskFields });
    chat(id, chatFields);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createAllSchemaTables(sqlite, schema);
    sqlite.exec(`
      INSERT INTO projects (id, name, repository) VALUES ('p', 'Project', 'acme/app'), ('foreign', 'Other', 'acme/other');
      INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'), ('teammate','Mate','m@example.com'), ('outsider','Out','x@example.com');
      INSERT INTO project_members (project_id, user_id, role, status) VALUES
        ('p','owner','owner','active'), ('p','teammate','member','active'), ('foreign','outsider','owner','active');
      INSERT INTO agent_profiles (id, project_id, user_id, name, agent_type) VALUES
        ('profile-build', 'p', 'owner', 'Opus 5.5 Build', 'claude-code'),
        ('profile-foreign', 'foreign', 'outsider', 'Foreign profile', 'claude-code'),
        ('profile-own-global', NULL, 'owner', 'My global profile', 'claude-code'),
        ('profile-mate-global', NULL, 'teammate', 'Teammate private profile', 'claude-code');
    `);
    mocks.snapshots.mockImplementation(async (_env: unknown, _projectId: string, ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            ideaId: id,
            sessions: [],
            needsInput: [],
            fileIds: [],
            pullRequestUrls: [],
            updates: 0,
            truncated: { sessions: false, files: false, pullRequests: false },
          },
        ])
      )
    );
    env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  });
  afterEach(() => sqlite.close());

  it('lists working, starting and waiting chats and leaves idle, sleeping and finished ones out', async () => {
    running('working');
    running('starting', { agent_completed_at: null }, { status: 'queued', execution_step: null });
    running('waiting', {
      agent_completed_at: NOW - 120_000,
      attention_json: JSON.stringify({ markerId: 'm1', kind: 'needs_input' }),
    });
    running('idle', { agent_completed_at: NOW - 120_000 });
    running('sleeping-chat', { status: 'sleeping' });
    running('sleeping-task', {}, { status: 'sleeping' });
    // The chat index still says active, but its task finished: not running.
    running('finished', {}, { status: 'completed', execution_step: null });
    running('awaiting', {}, { execution_step: 'awaiting_followup' });

    const result = await projectOverviewGet(ctx(), { projectId: 'p' });

    const byId = new Map(result.running.items.map((item) => [item.sessionId, item]));
    expect([...byId.keys()].sort()).toEqual(['starting', 'waiting', 'working']);
    expect(result.running.total).toBe(3);
    expect(byId.get('working')).toMatchObject({
      state: 'working',
      topic: 'Chat working',
      taskId: 'task-working',
      profile: { id: 'profile-build', name: 'Opus 5.5 Build' },
      startedAt: NOW - 3_600_000,
      lastActivityAt: NOW - 60_000,
    });
    expect(byId.get('starting')?.state).toBe('starting');
    expect(byId.get('waiting')).toMatchObject({ state: 'waiting', waitingOnViewer: true });
    expect(result.unavailable).toEqual([]);
  });

  it('says a question is the viewer’s only when the viewer started the chat', async () => {
    running('waiting', {
      agent_completed_at: NOW - 1,
      attention_json: JSON.stringify({ markerId: 'm1' }),
    });
    const result = await projectOverviewGet(ctx('teammate'), { projectId: 'p' });
    expect(result.running.items).toEqual([
      expect.objectContaining({ sessionId: 'waiting', state: 'waiting', waitingOnViewer: false }),
    ]);
  });

  it('never returns another project’s chats, tasks or profiles (owner control beside each attack)', async () => {
    // Owner control: the same shape inside the project is listed.
    running('mine');
    // Attack 1: a running chat in a foreign project.
    task('task-foreign-chat', { project_id: 'foreign', user_id: 'outsider' });
    chat('foreign-chat', {
      project_id: 'foreign',
      user_id: 'outsider',
      task_id: 'task-foreign-chat',
    });
    // Attack 2: our chat row pointing at a foreign project's running task.
    task('task-borrowed', { project_id: 'foreign', user_id: 'outsider' });
    chat('borrowed', { task_id: 'task-borrowed' });
    // Attack 3: our task naming a foreign project's profile.
    running('foreign-profile', {}, { agent_profile_hint: 'profile-foreign' });
    // Attack 4: a task naming another member's private global profile.
    running('mate-global', {}, { agent_profile_hint: 'profile-mate-global' });
    // Owner control: the task creator's own global profile is named.
    running('own-global', {}, { agent_profile_hint: 'profile-own-global' });

    const result = await projectOverviewGet(ctx(), { projectId: 'p' });

    const ids = result.running.items.map((item) => item.sessionId).sort();
    expect(ids).toEqual(['foreign-profile', 'mate-global', 'mine', 'own-global']);
    const profileOf = (id: string) => result.running.items.find((i) => i.sessionId === id)?.profile;
    expect(profileOf('foreign-profile')).toBeNull();
    expect(profileOf('mate-global')).toBeNull();
    expect(profileOf('own-global')).toEqual({
      id: 'profile-own-global',
      name: 'My global profile',
    });
  });

  it('refuses a caller who is not a member, with the same answer as a missing project', async () => {
    running('mine');
    await expect(projectOverviewGet(ctx('outsider'), { projectId: 'p' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      projectOverviewGet(ctx('outsider'), { projectId: 'missing' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });

  it('caps the list newest first and still counts every running chat', async () => {
    for (let i = 0; i < 12; i++) running(`chat-${i}`, { last_message_at: NOW - i * 1000 });
    const result = await projectOverviewGet(ctx(), { projectId: 'p' });
    expect(result.running.items.map((item) => item.sessionId)).toEqual([
      'chat-0',
      'chat-1',
      'chat-2',
      'chat-3',
      'chat-4',
    ]);
    expect(result.running.total).toBe(12);
  });

  it('ranks chats waiting on the viewer first, so the cap never hides them, and counts them', async () => {
    for (let i = 0; i < 8; i++) running(`busy-${i}`, { last_message_at: NOW - i * 1000 });
    // Older than every busy chat: by recency alone it would fall behind the cap of five.
    const question = JSON.stringify({ markerId: 'm1' });
    running('old-question', {
      last_message_at: NOW - HOUR,
      agent_completed_at: NOW - HOUR,
      attention_json: question,
    });
    running('older-question', {
      last_message_at: NOW - 2 * HOUR,
      agent_completed_at: NOW - 2 * HOUR,
      attention_json: question,
    });
    // Control: a teammate's waiting chat is not the owner's to answer and is not lifted.
    running('mates-question', {
      last_message_at: NOW - 3 * HOUR,
      agent_completed_at: NOW - 3 * HOUR,
      attention_json: question,
      created_by_user_id: 'teammate',
    });

    const result = await projectOverviewGet(ctx(), { projectId: 'p' });

    expect(result.running.items.map((item) => item.sessionId)).toEqual([
      'old-question',
      'older-question',
      'busy-0',
      'busy-1',
      'busy-2',
    ]);
    expect(result.running.total).toBe(11);
    expect(result.running.waitingOnViewerTotal).toBe(2);
    // The teammate sees their own question first and counts only that one.
    const mate = await projectOverviewGet(ctx('teammate'), { projectId: 'p' });
    expect(mate.running.items[0]?.sessionId).toBe('mates-question');
    expect(mate.running.waitingOnViewerTotal).toBe(1);
  });

  /** An agent question held in D1 `asks` (inbox slice G): not copied into the chat summary. */
  function question(
    id: string,
    sessionId: string,
    fields: Record<string, string | number | null> = {}
  ): void {
    const now = Date.now();
    insert('asks', {
      id,
      project_id: 'p',
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      kind: 'question',
      blocking: 1,
      title: 'Which region?',
      source_session_id: sessionId,
      status: 'open',
      expires_at: now + HOUR,
      created_at: now,
      updated_at: now,
      ...fields,
    });
  }

  it('reads a chat paused on an open question ask as waiting, ranked first and counted', async () => {
    // Idle chats with no attention marker: only the ask can make them show.
    const idle = { agent_completed_at: NOW - 120_000, last_message_at: NOW - 10 * HOUR };
    running('asked', idle);
    question('ask-1', 'asked');
    running('fresh', {}, {});
    // Controls: an expired and an answered question leave the chat idle (not shown).
    running('expired-q', idle);
    question('ask-expired', 'expired-q', { expires_at: Date.now() - 1 });
    running('answered-q', idle);
    question('ask-answered', 'answered-q', { status: 'answered' });
    // Attack: another project's open question naming this project's chat id.
    running('foreign-q', idle);
    question('ask-foreign', 'foreign-q', { project_id: 'foreign' });

    const result = await projectOverviewGet(ctx(), { projectId: 'p', runningLimit: 1 });
    // The cap is 1: the waiting chat outranks the newer working one.
    expect(result.running.items).toEqual([
      expect.objectContaining({ sessionId: 'asked', state: 'waiting', waitingOnViewer: true }),
    ]);
    expect(result.running.total).toBe(2);
    expect(result.running.waitingOnViewerTotal).toBe(1);
  });

  /** A pending `request_secret` from a chat: the inbox lists it as a blocking item. */
  function secretRequest(
    id: string,
    sessionId: string,
    fields: Record<string, string | number | null> = {}
  ): void {
    const now = Date.now();
    insert('runtime_secret_requests', {
      id,
      project_id: 'p',
      env_key: 'STRIPE_KEY',
      reason: 'Webhooks need it',
      status: 'pending',
      requester_user_id: 'owner',
      requesting_task_id: `task-${sessionId}`,
      requesting_authority_task_id: `task-${sessionId}`,
      requesting_chat_session_id: sessionId,
      expires_at: now + HOUR,
      created_at: now,
      updated_at: now,
      ...fields,
    });
  }

  it('keeps a chat paused on a pending secret request in Running now, as waiting (slice F2)', async () => {
    // The agent ended its turn after asking: without the request the chat is idle and hidden,
    // while the inbox still calls it "paused on this".
    const idle = { agent_completed_at: NOW - 120_000, last_message_at: NOW - 10 * HOUR };
    running('secret-wait', idle);
    secretRequest('sr-1', 'secret-wait');
    // Controls: expired and fulfilled requests leave the chat idle (not shown).
    running('secret-expired', idle);
    secretRequest('sr-expired', 'secret-expired', { expires_at: Date.now() - 1 });
    running('secret-done', idle);
    secretRequest('sr-done', 'secret-done', { status: 'fulfilled' });
    // Attack: another project's pending request naming this project's chat id.
    running('secret-foreign', idle);
    secretRequest('sr-foreign', 'secret-foreign', { project_id: 'foreign' });

    const result = await projectOverviewGet(ctx(), { projectId: 'p' });
    expect(result.running.items).toEqual([
      expect.objectContaining({
        sessionId: 'secret-wait',
        state: 'waiting',
        waitingOnViewer: true,
      }),
    ]);
    expect(result.running.total).toBe(1);
    expect(result.running.waitingOnViewerTotal).toBe(1);

    // A teammate sees the chat as paused too, but not on them: it is the creator's to answer.
    const mate = await projectOverviewGet(ctx('teammate'), { projectId: 'p' });
    expect(mate.running.items).toEqual([
      expect.objectContaining({ sessionId: 'secret-wait', state: 'waiting', waitingOnViewer: false }),
    ]);
    expect(mate.running.waitingOnViewerTotal).toBe(0);
  });

  it('skips one malformed row and keeps the rest', async () => {
    running('good');
    running('bad');
    // A start time that is not a number is a row the reader cannot trust.
    sqlite.prepare(`UPDATE session_summaries SET started_at = 'yesterday' WHERE id = 'bad'`).run();
    const result = await projectOverviewGet(ctx(), { projectId: 'p' });
    expect(result.running.items.map((item) => item.sessionId)).toEqual(['good']);
    expect(result.running.total).toBe(2);
    expect(result.unavailable).toEqual([]);
  });

  it('returns the newest merged pull requests of this project only', async () => {
    const pr = (number: number, fields: Record<string, string | number | null>) =>
      insert('pull_requests', {
        id: `pr-${number}-${String(fields.project_id ?? 'p')}`,
        project_id: 'p',
        repository: 'acme/app',
        number,
        url: `https://github.com/acme/app/pull/${number}`,
        title: `PR ${number}`,
        state: 'merged',
        is_draft: 0,
        created_at: '2026-11-01T00:00:00.000Z',
        updated_at: '2026-11-01T00:00:00.000Z',
        ...fields,
      });
    pr(1, { merged_at: '2026-11-10T00:00:00.000Z' });
    pr(2, { merged_at: '2026-11-14T00:00:00.000Z' });
    pr(3, { merged_at: '2026-11-12T00:00:00.000Z' });
    pr(4, { merged_at: '2026-11-15T00:00:00.000Z' });
    pr(5, { state: 'open', merged_at: null });
    pr(6, { state: 'closed', merged_at: null });
    pr(7, {
      project_id: 'foreign',
      repository: 'acme/other',
      merged_at: '2026-11-16T00:00:00.000Z',
    });
    pr(8, { url: 'not a url', merged_at: '2026-11-15T12:00:00.000Z' });
    pr(9, { url: 'javascript:alert(1)', merged_at: '2026-11-15T13:00:00.000Z' });

    const result = await projectOverviewGet(ctx(), { projectId: 'p' });

    // The two newest rows are malformed (not a URL, not https) and are skipped, not refilled:
    // the read is capped at three rows and a bad row costs its own slot only.
    expect(result.recent.mergedPullRequests.map((item) => item.number)).toEqual([4]);
    expect(result.recent.mergedPullRequests[0]).toEqual({
      number: 4,
      url: 'https://github.com/acme/app/pull/4',
      title: 'PR 4',
      repository: 'acme/app',
      mergedAt: '2026-11-15T00:00:00.000Z',
    });
  });

  it('returns the three most recently updated ideas, open or closed, from this project only', async () => {
    const idea = (id: string, status: string, updatedAt: string, projectId = 'p') =>
      task(id, {
        project_id: projectId,
        is_idea: 1,
        status,
        execution_step: null,
        agent_profile_hint: null,
        updated_at: updatedAt,
      });
    idea('idea-old', 'draft', '2026-11-01T00:00:00.000Z');
    idea('idea-done', 'completed', '2026-11-15T00:00:00.000Z');
    idea('idea-new', 'draft', '2026-11-16T00:00:00.000Z');
    idea('idea-mid', 'draft', '2026-11-10T00:00:00.000Z');
    idea('idea-foreign', 'draft', '2026-11-16T01:00:00.000Z', 'foreign');

    const result = await projectOverviewGet(ctx(), { projectId: 'p' });

    expect(result.recent.ideas.map((item) => item.ideaId)).toEqual([
      'idea-new',
      'idea-done',
      'idea-mid',
    ]);
  });

  it('names a failed section instead of failing the page', async () => {
    running('working');
    task('idea-1', { is_idea: 1, status: 'draft', execution_step: null });
    mocks.snapshots.mockRejectedValue(new Error('ProjectData unavailable'));
    const result = await projectOverviewGet(ctx(), { projectId: 'p' });
    expect(result.unavailable).toEqual(['ideas']);
    expect(result.recent.ideas).toEqual([]);
    expect(result.running.items.map((item) => item.sessionId)).toEqual(['working']);
  });

  it('stays within the dashboard round-trip budget with ideas that have linked work', async () => {
    running('working');
    for (let i = 0; i < 3; i++) {
      task(`idea-${i}`, { is_idea: 1, status: 'draft', execution_step: null });
      task(`task-idea-${i}`, { chat_session_id: `idea-chat-${i}` });
    }
    // Every idea has a strong linked chat, so evidence reads (tasks, PR associations, profile
    // names, PR states) all run: the expensive shape, not the empty one.
    mocks.snapshots.mockImplementation(async (_env: unknown, _projectId: string, ids: string[]) =>
      Object.fromEntries(
        ids.map((id) => [
          id,
          {
            ideaId: id,
            sessions: [
              {
                sessionId: `idea-chat-${id}`,
                topic: 'Working on it',
                sessionStatus: 'active',
                sessionTaskId: `task-${id}`,
                lastActivityAt: NOW,
                relations: ['implements'],
                strong: true,
                linkedAt: NOW - HOUR,
              },
            ],
            needsInput: [],
            fileIds: [],
            pullRequestUrls: ['https://github.com/acme/app/pull/7'],
            updates: 1,
            truncated: { sessions: false, files: false, pullRequests: false },
          },
        ])
      )
    );
    const d1 = env.DATABASE;
    let d1Reads = 0;
    env = {
      ...env,
      DATABASE: new Proxy(d1, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (sql: string) => {
              d1Reads += 1;
              return target.prepare(sql);
            };
          }
          if (prop === 'batch') {
            return (statements: unknown[]) => {
              d1Reads += 1;
              return (target.batch as (s: unknown[]) => Promise<unknown>)(statements);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    } as Env;

    const result = await projectOverviewGet(ctx(), { projectId: 'p' });

    expect(result.unavailable).toEqual([]);
    expect(result.recent.ideas).toHaveLength(3);
    const doCalls = mocks.snapshots.mock.calls.length;
    // .claude/rules/60: a dashboard read spends at most 20 D1 + DO round trips.
    expect(d1Reads + doCalls).toBeLessThanOrEqual(20);
    expect(doCalls).toBe(1);
  });

  it('reads the newest merged pull requests from an index, without sorting the project history', async () => {
    createDeclaredIndexes(sqlite, [schema.pullRequests]);
    const seen: string[] = [];
    const d1 = env.DATABASE;
    env = {
      ...env,
      DATABASE: new Proxy(d1, {
        get(target, prop, receiver) {
          if (prop === 'prepare') {
            return (sql: string) => {
              seen.push(sql);
              return target.prepare(sql);
            };
          }
          return Reflect.get(target, prop, receiver);
        },
      }),
    } as Env;
    await projectOverviewGet(ctx(), { projectId: 'p' });
    const sql = seen.find((statement) => statement.includes('FROM pull_requests'));
    expect(sql).toBeDefined();
    const plan = sqlite
      .prepare(`EXPLAIN QUERY PLAN ${sql}`)
      .all('p', 3)
      .map((row) => (row as { detail: string }).detail)
      .join('\n');
    expect(plan).toContain('idx_pull_requests_project_state_merged');
    expect(plan).not.toContain('TEMP B-TREE');
  });
});
