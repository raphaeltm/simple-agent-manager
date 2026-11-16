/**
 * Inbox operations on a real SQL engine (`.claude/rules/28`, `.claude/rules/11`): the list read,
 * single-item binding, and the `asks` compare-and-set writes run against SQLite with the shipped
 * 0245 migration. Attack cases are paired with owner controls; only the ProjectData prompt
 * delivery (the agent's notice) and the session-access lookup are replaced.
 */
import { readFileSync } from 'node:fs';

import type { OperationContext } from '@simple-agent-manager/operations';
import {
  archiveInboxItem,
  answerInboxItem,
  countInbox,
  createAsk,
  getInboxItem,
  listInbox,
} from '@simple-agent-manager/operations';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({ acceptPromptDelivery: vi.fn() }));
vi.mock('../../../src/services/project-data', async () => ({
  ...(await vi.importActual<typeof import('../../../src/services/project-data')>(
    '../../../src/services/project-data'
  )),
  acceptPromptDelivery: edges.acceptPromptDelivery,
}));

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { createOperationPorts } from '../../../src/operation-ports';
import { runInboxAskSweep } from '../../../src/services/inbox/sweep';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const P1 = 'proj-1';
const P2 = 'proj-2';
let sqlite: Database.Database;
let env: Env;

function ctx(userId: string): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    actor: { userId, via: 'web', scopes: new Set(['sam.read', 'sam.write']) },
    requestId: 'test',
  };
}

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

let clock = 1_000;
function ask(id: string, row: Record<string, unknown> = {}) {
  clock += 1;
  insert('asks', {
    id,
    project_id: P1,
    assignee_kind: 'user',
    assignee_user_id: 'owner',
    kind: 'review',
    blocking: 0,
    title: `Title ${id}`,
    status: 'open',
    created_at: clock,
    updated_at: clock,
    ...row,
  });
}

function summary(
  id: string,
  projectId: string,
  creator: string,
  extra: Record<string, unknown> = {}
) {
  clock += 1;
  insert('session_summaries', {
    id,
    project_id: projectId,
    user_id: 'owner',
    created_by_user_id: creator,
    status: 'active',
    started_at: clock,
    updated_at: clock,
    attention_json: JSON.stringify({
      markerId: `m-${id}`,
      kind: 'needs_input',
      createdAt: clock,
      expiresAt: null,
      reason: `Question in ${id}?`,
      options: [],
      ...extra,
    }),
  });
}

function askRow(id: string) {
  return sqlite.prepare('SELECT * FROM asks WHERE id = ?').get(id) as Record<string, unknown>;
}

beforeEach(() => {
  clock = 1_000;
  edges.acceptPromptDelivery.mockReset().mockResolvedValue({ message: { id: 'd' } });
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  // The shipped migration, not the drizzle mirror: its partial unique index is under test.
  sqlite.exec('DROP TABLE asks');
  sqlite.exec(
    readFileSync(new URL('../../../src/db/migrations/0245_asks.sql', import.meta.url), 'utf8')
  );
  for (const [id, role] of [
    ['owner', 'user'],
    ['colleague', 'user'],
    ['viewer', 'user'],
    ['outsider', 'user'],
    ['admin', 'superadmin'],
  ])
    insert('users', { id, email: `${id}@x.test`, name: id, role, status: 'active' });
  insert('projects', { id: P1, user_id: 'owner', name: 'One', repository: 'o/one' });
  insert('projects', { id: P2, user_id: 'outsider', name: 'Two', repository: 'o/two' });
  for (const [project, user, role] of [
    [P1, 'owner', 'owner'],
    [P1, 'colleague', 'maintainer'],
    [P1, 'viewer', 'viewer'],
    [P1, 'admin', 'admin'],
    [P2, 'outsider', 'owner'],
  ])
    insert('project_members', { project_id: project, user_id: user, role, status: 'active' });
  insert('tasks', {
    id: 'task-1',
    project_id: P1,
    user_id: 'owner',
    title: 'Task',
    status: 'in_progress',
    chat_session_id: 'chat-1',
  });
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    DURABLE_PROMPT_DELIVERY_ENABLED: 'true',
  } as unknown as Env;
});

afterEach(() => {
  vi.restoreAllMocks();
  sqlite.close();
});

const refs = (result: { items: { ref: string }[] }) => result.items.map((item) => item.ref);

describe('inbox list tenancy', () => {
  it('lists my asks and my chats only, in projects where I am an active member', async () => {
    ask('mine');
    ask('colleagues', { assignee_user_id: 'colleague' });
    // A stale assignment in a project the owner does not belong to.
    ask('foreign', { project_id: P2 });
    summary('my-chat', P1, 'owner');
    summary('colleague-chat', P1, 'colleague');
    summary('foreign-chat', P2, 'owner');

    expect(refs(await listInbox(ctx('owner'), {}))).toEqual(
      expect.arrayContaining(['ask:mine', 'attention:my-chat:m-my-chat'])
    );
    expect(refs(await listInbox(ctx('owner'), {}))).toHaveLength(2);
    // Owner control on the other side of the same fixture.
    expect(refs(await listInbox(ctx('colleague'), {})).sort()).toEqual([
      'ask:colleagues',
      'attention:colleague-chat:m-colleague-chat',
    ]);
    // Membership ends: the items go with it.
    sqlite.prepare("UPDATE project_members SET status = 'removed' WHERE user_id = 'owner'").run();
    expect(refs(await listInbox(ctx('owner'), {}))).toEqual([]);
  });

  it('a project-scoped list stays in its project and refuses a non-member', async () => {
    ask('mine');
    summary('my-chat', P1, 'owner');
    expect(refs(await listInbox(ctx('owner'), { projectId: P1 }))).toHaveLength(2);
    expect(refs(await listInbox(ctx('owner'), { projectId: P2 }))).toEqual([]);
  });

  it('shows approvals only to an active superadmin member, and secrets to the requester', async () => {
    const future = new Date(Date.now() + 3_600_000).toISOString();
    insert('operations_action_approvals', {
      id: 'appr',
      action: 'node.reboot',
      target_type: 'node',
      target_id: 'node-1',
      reason: 'It is wedged',
      requesting_project_id: P1,
      requesting_task_id: 'task-1',
      requesting_authority_task_id: 'task-1',
      requesting_session_id: 'chat-1',
      requester_user_id: 'owner',
      status: 'pending',
      expires_at: future,
      created_at: new Date().toISOString(),
    });
    insert('runtime_secret_requests', {
      id: 'sec',
      project_id: P1,
      env_key: 'API_KEY',
      reason: 'Need it',
      status: 'pending',
      requester_user_id: 'owner',
      requesting_task_id: 'task-1',
      requesting_authority_task_id: 'task-1',
      requesting_chat_session_id: 'chat-1',
      expires_at: Date.now() + 3_600_000,
      created_at: Date.now(),
      updated_at: Date.now(),
    });
    expect(refs(await listInbox(ctx('admin'), {}))).toEqual(['approval:appr']);
    expect(refs(await listInbox(ctx('owner'), {}))).toEqual(['secret:sec']);
    expect(refs(await listInbox(ctx('colleague'), {}))).toEqual([]);
    // A superadmin who is not a member of the requesting project does not see it.
    sqlite.prepare("DELETE FROM project_members WHERE user_id = 'admin'").run();
    expect(refs(await listInbox(ctx('admin'), {}))).toEqual([]);
  });

  it('a viewer sees an item assigned to them but cannot act, and the count follows canAct', async () => {
    ask('for-viewer', { assignee_user_id: 'viewer', blocking: 1 });
    const viewer = await listInbox(ctx('viewer'), { filter: 'blocking' });
    expect(viewer.items[0]).toMatchObject({ ref: 'ask:for-viewer', canAct: false });
    expect(refs(await listInbox(ctx('viewer'), {}))).toEqual([]);
    expect(await countInbox(ctx('viewer'), {})).toEqual({ needsYou: 0, blocking: 0 });
    ask('blocking', { blocking: 1 });
    ask('plain');
    expect(await countInbox(ctx('owner'), {})).toEqual({ needsYou: 2, blocking: 1 });
  });
});

describe('inbox list shape', () => {
  it('sorts live deadlines first, then blocking, then the rest, with a chat’s items stacked', async () => {
    ask('rest-old');
    ask('blocking-a', { blocking: 1, source_session_id: 'chat-a', source_task_id: 'task-1' });
    ask('blocking-b', { blocking: 1, source_session_id: 'chat-b', source_task_id: 'task-1' });
    ask('blocking-a2', { blocking: 1, source_session_id: 'chat-a', source_task_id: 'task-1' });
    summary('perm-chat', P1, 'owner', {
      source: 'acp_interaction',
      reason: 'acp_interaction_pending',
      interactionId: 'i-1',
      interactionKind: 'permission',
    });
    ask('rest-new');
    const result = await listInbox(ctx('owner'), {});
    expect(refs(result)).toEqual([
      'attention:perm-chat:m-perm-chat',
      'ask:blocking-a',
      'ask:blocking-a2',
      'ask:blocking-b',
      'ask:rest-old',
      'ask:rest-new',
    ]);
    expect(result.items[0]).toMatchObject({
      kind: 'permission',
      answerSpec: { type: 'interaction', interactionId: 'i-1', interactionKind: 'permission' },
    });
  });

  it('filters tasks, reviews and archived', async () => {
    ask('task', { kind: 'task' });
    ask('review');
    ask('gone', { status: 'archived' });
    expect(refs(await listInbox(ctx('owner'), { filter: 'tasks' }))).toEqual(['ask:task']);
    expect(refs(await listInbox(ctx('owner'), { filter: 'reviews' }))).toEqual(['ask:review']);
    expect(refs(await listInbox(ctx('owner'), { filter: 'archived' }))).toEqual(['ask:gone']);
  });

  it('pages through every item once with the cursor', async () => {
    for (let index = 0; index < 7; index += 1) ask(`a${index}`);
    summary('chat-q', P1, 'owner');
    const seen: string[] = [];
    let cursor: string | undefined;
    do {
      const page = await listInbox(ctx('owner'), { limit: 3, cursor });
      seen.push(...refs(page));
      cursor = page.nextCursor ?? undefined;
    } while (cursor);
    expect(seen).toHaveLength(8);
    expect(new Set(seen).size).toBe(8);
  });

  it('skips one malformed row and keeps the others; an all-bad page is empty, not an error', async () => {
    ask('good-1');
    ask('bad', { kind: 'not-a-kind' });
    ask('bad-links', { links_json: '{not json' });
    ask('good-2');
    const result = await listInbox(ctx('owner'), {});
    expect(refs(result)).toEqual(['ask:good-1', 'ask:good-2']);
    expect(result.skipped).toBe(2);
    sqlite.prepare("DELETE FROM asks WHERE id LIKE 'good%'").run();
    await expect(listInbox(ctx('owner'), {})).resolves.toMatchObject({ items: [], skipped: 2 });
  });
});

describe('inbox single item binding', () => {
  it('answers the same not-found for a missing item and a foreign one', async () => {
    ask('foreign', { project_id: P2, assignee_user_id: 'outsider' });
    ask('mine');
    const missing = getInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:nope' });
    const foreign = getInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:foreign' });
    await expect(missing).rejects.toMatchObject({
      code: 'not_found',
      message: 'Inbox item not found',
    });
    await expect(foreign).rejects.toMatchObject({
      code: 'not_found',
      message: 'Inbox item not found',
    });
    // A ref shape this build does not issue is also just not found.
    await expect(
      getInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:../x' })
    ).rejects.toMatchObject({ code: 'not_found' });
    // Owner control.
    await expect(
      getInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:mine' })
    ).resolves.toMatchObject({
      item: { ref: 'ask:mine', canAct: true },
    });
    // Another member's item is invisible to me.
    await expect(
      getInboxItem(ctx('colleague'), { projectId: P1, ref: 'ask:mine' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});

describe('inbox project binding for a member of both projects', () => {
  it('an item of one project is not reachable through the other project', async () => {
    insert('project_members', {
      project_id: P2,
      user_id: 'owner',
      role: 'owner',
      status: 'active',
    });
    ask('in-p2', { project_id: P2 });
    await expect(
      getInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:in-p2' })
    ).rejects.toMatchObject({ code: 'not_found' });
    await expect(
      archiveInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:in-p2' })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(askRow('in-p2').status).toBe('open');
    // Owner control: through its own project it is found and archivable.
    await expect(
      archiveInboxItem(ctx('owner'), { projectId: P2, ref: 'ask:in-p2' })
    ).resolves.toMatchObject({ outcome: 'archived' });
  });
});

describe('inbox asks writes', () => {
  it('a foreign-project archive changes nothing; the owner archive closes it', async () => {
    ask('target');
    // An outsider names their own project and the target's id.
    await expect(
      archiveInboxItem(ctx('outsider'), { projectId: P2, ref: 'ask:target' })
    ).rejects.toMatchObject({ code: 'not_found' });
    // A member of the project who is not the assignee.
    await expect(
      archiveInboxItem(ctx('colleague'), { projectId: P1, ref: 'ask:target' })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(askRow('target')).toMatchObject({ status: 'open', resolved_by_user_id: null });
    await expect(
      archiveInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:target' })
    ).resolves.toMatchObject({ outcome: 'archived' });
    expect(askRow('target')).toMatchObject({ status: 'archived', resolved_by_user_id: 'owner' });
  });

  it('two concurrent answers: exactly one wins', async () => {
    ask('race', { kind: 'question', answer_spec_json: JSON.stringify({ type: 'text' }) });
    const results = await Promise.allSettled([
      answerInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:race', answer: 'first' }),
      answerInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:race', answer: 'second' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(results.find((result) => result.status === 'rejected')).toMatchObject({
      reason: { code: 'conflict' },
    });
    expect(askRow('race').status).toBe('answered');
  });

  it('answer versus archive: exactly one wins', async () => {
    ask('race', { kind: 'question', answer_spec_json: JSON.stringify({ type: 'text' }) });
    const results = await Promise.allSettled([
      answerInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:race', answer: 'yes' }),
      archiveInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:race' }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    expect(['answered', 'archived']).toContain(askRow('race').status);
  });

  it('a stale read cannot close an item another writer already closed (compare-and-set)', async () => {
    ask('stale', { kind: 'task' });
    // Close it behind the operation's back, then let the operation act on what it read.
    const original = env.DATABASE.prepare.bind(env.DATABASE);
    let closed = false;
    vi.spyOn(env.DATABASE, 'prepare').mockImplementation((query: string) => {
      if (!closed && query.trimStart().startsWith('UPDATE asks')) {
        closed = true;
        sqlite.prepare("UPDATE asks SET status = 'archived' WHERE id = 'stale'").run();
      }
      return original(query);
    });
    await expect(
      answerInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:stale' })
    ).rejects.toMatchObject({ code: 'conflict' });
    expect(askRow('stale').status).toBe('archived');
  });

  it('a notice that cannot be queued leaves notified_at NULL and the sweep retries it', async () => {
    ask('notice', { source_session_id: 'chat-1', source_task_id: 'task-1' });
    edges.acceptPromptDelivery.mockRejectedValueOnce(new Error('DO unavailable'));
    await expect(
      archiveInboxItem(ctx('owner'), { projectId: P1, ref: 'ask:notice' })
    ).resolves.toMatchObject({ outcome: 'archived', agentNotified: false });
    expect(askRow('notice').notified_at).toBeNull();
    const resolvedAt = Number(askRow('notice').resolved_at);
    await expect(runInboxAskSweep(env, resolvedAt + 120_000)).resolves.toMatchObject({
      noticesRetried: 1,
    });
    expect(askRow('notice').notified_at).not.toBeNull();
    expect(edges.acceptPromptDelivery).toHaveBeenLastCalledWith(
      env,
      P1,
      expect.objectContaining({
        deliveryId: 'inbox-ask:notice',
        sourceKind: 'inbox_ask',
        sourceTaskId: 'task-1',
        targetSessionId: 'chat-1',
        metadata: expect.objectContaining({ creatorUserId: 'owner', outcome: 'archived' }),
      })
    );
    // Retried once: a second sweep has nothing left to do.
    await expect(runInboxAskSweep(env, resolvedAt + 180_000)).resolves.toMatchObject({
      noticesRetried: 0,
    });
  });

  it('the sweep expires an open ask past its deadline and leaves an unexpired one', async () => {
    ask('due', { expires_at: 5_000, source_session_id: 'chat-1', source_task_id: 'task-1' });
    ask('later', { expires_at: 50_000 });
    await expect(runInboxAskSweep(env, 10_000)).resolves.toMatchObject({ expired: 1 });
    expect(askRow('due')).toMatchObject({ status: 'expired' });
    expect(askRow('due').notified_at).not.toBeNull();
    expect(askRow('later').status).toBe('open');
  });
});

describe('createAsk', () => {
  const base = {
    projectId: P1,
    assigneeUserId: 'owner',
    kind: 'task' as const,
    title: 'Rotate the deploy key.',
    sourceSessionId: 'chat-1',
    sourceTaskId: 'task-1',
  };

  it('refuses an assignee who is not an active member and a source task from another project', async () => {
    await expect(
      createAsk(ctx('owner'), { ...base, assigneeUserId: 'outsider' })
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    insert('tasks', {
      id: 'task-2',
      project_id: P2,
      user_id: 'outsider',
      title: 'x',
      status: 'queued',
    });
    await expect(
      createAsk(ctx('owner'), { ...base, sourceTaskId: 'task-2' })
    ).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(createAsk(ctx('owner'), base)).resolves.toMatchObject({ created: true });
  });

  it('returns the existing row for a repeated dedupe key', async () => {
    const first = await createAsk(ctx('owner'), { ...base, dedupeKey: 'k' });
    const second = await createAsk(ctx('owner'), { ...base, dedupeKey: 'k', title: 'Other' });
    expect(second).toEqual({ ref: first.ref, id: first.id, created: false });
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM asks').get()).toEqual({ n: 1 });
  });

  it('caps open items per chat with the admin setting', async () => {
    insert('platform_settings', {
      key: 'inbox.openItemsPerChat',
      value: '2',
      updated_at: '2026-11-16T00:00:00Z',
    });
    await createAsk(ctx('owner'), base);
    await createAsk(ctx('owner'), base);
    await expect(createAsk(ctx('owner'), base)).rejects.toMatchObject({ code: 'rate_limited' });
    // Another chat is not capped by this one.
    insert('tasks', {
      id: 'task-3',
      project_id: P1,
      user_id: 'owner',
      title: 'y',
      status: 'queued',
    });
    await expect(
      createAsk(ctx('owner'), { ...base, sourceSessionId: 'chat-2', sourceTaskId: 'task-3' })
    ).resolves.toMatchObject({ created: true });
  });
});
