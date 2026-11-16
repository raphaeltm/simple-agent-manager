/**
 * A failed chat wake as an inbox error item (inbox slice E), end to end on real engines
 * (`.claude/rules/62`, `.claude/rules/28`).
 *
 * Real: ProjectData's `runPromptDeliveryClaim` (the delivery alarm's own claim runner, applying a
 * `wake_refused` result), `raiseSessionWakeFailure`, the worker's `inboxErrorsPort` installed in the
 * ProjectData ports registry, `fileAndNotify` -> `fileSystemError` -> `createAsk`, the shipped
 * `asks` migrations on a real SQL engine, `signalSessionWakeReadyBestEffort` and the chat-index
 * read (`listSessionsFromIndex`). ProjectData's own SQLite is the real migrated schema.
 *
 * Substituted: the node-agent submit (the delivery adapter reports `wake_refused`), the
 * notification Durable Object, and the ProjectData `signalSessionWakeReady` RPC hop (a recovered
 * wake's scheduling signal, which is not what closes the item).
 *
 * The persisted-human-message close is proven in the workers pool, through the real Durable Object
 * (`tests/workers/wake-failure-item-lifecycle.test.ts`).
 */
import { configureProjectDataPort } from '@simple-agent-manager/project-data';
import type { DurableExecutionConfig } from '@simple-agent-manager/project-data/internal/do/durable-execution-config';
import { runMigrations } from '@simple-agent-manager/project-data/internal/do/migrations';
import { claimDuePromptDeliveries } from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { acceptPromptDelivery } from '@simple-agent-manager/project-data/internal/do/prompt-delivery';
import { runPromptDeliveryClaim } from '@simple-agent-manager/project-data/internal/do/prompt-delivery-runner';
import type { SessionWakeReadyInput } from '@simple-agent-manager/project-data/internal/do/session-wake-ready';
import { raiseSessionWakeFailure } from '@simple-agent-manager/project-data/internal/do/wake-failure';
import { readOpenQuestionAttention } from '@simple-agent-manager/worker-core';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../../src/db/schema';
import type { Env } from '../../../../src/env';
import { inboxErrorsPort } from '../../../../src/project-data-ports/inbox-errors';
import { listSessionsFromIndex } from '../../../../src/services/session-summary-index';
import { signalSessionWakeReadyBestEffort } from '../../../../src/services/session-wake-ready';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../../helpers/sqlite-d1';
import { createSqlStorage } from '../../durable-objects/sql-storage-test-utils';

const P1 = 'proj-1';
const P2 = 'proj-2';
const CHAT = 'chat-1';
const OTHER_CHAT = 'chat-2';

const config: DurableExecutionConfig = {
  deliveryEnabled: true,
  legacyVmCompatEnabled: false,
  supervisorEnabled: false,
  checkpointThresholdMs: 18_000_000,
  preemptGraceMs: 30_000,
  maxCandidatesPerAlarm: 5,
  maxAttempts: 3,
  retryBaseMs: 5_000,
  retryMaxMs: 20_000,
  ttlMs: 600_000,
  receiptTimeoutMs: 10_000,
  backgroundTimeoutMs: 5_000,
  minAlarmDelayMs: 1_000,
};

let d1Sqlite: Database.Database;
let doSqlite: Database.Database;
let sql: SqlStorage;
let env: Env;
const createNotification = vi.fn();
const signalSessionWakeReady = vi.fn();
const broadcastEvent = vi.fn();

const hooks = {
  projectId: P1,
  recalculateAlarm: vi.fn(async () => {}),
  broadcastEvent,
  scheduleSummarySync: vi.fn(),
  armIdleCleanup: vi.fn(),
  nudgeDeliveries: vi.fn(() => 0),
};

function insertD1(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  d1Sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

/** A task of a project, optionally the one bound to a chat. */
function task(id: string, userId: string | null, chatSessionId: string | null, project = P1) {
  insertD1('tasks', {
    id,
    project_id: project,
    user_id: userId,
    title: `Ship ${id}`,
    status: 'in_progress',
    chat_session_id: chatSessionId,
    updated_at: new Date().toISOString(),
  });
}

/** The chat as ProjectData stores it (its own SQLite). */
function chat(
  id: string,
  row: { status?: string; createdBy?: string | null; topic?: string | null } = {}
) {
  sql.exec(
    `INSERT INTO chat_sessions
       (id, workspace_id, topic, status, message_count, started_at, created_at, updated_at,
        created_by_user_id)
     VALUES (?, 'workspace-1', ?, ?, 0, 10000, 10000, 10000, ?)`,
    id,
    row.topic === undefined ? 'Fix the login bug' : row.topic,
    row.status ?? 'sleeping',
    row.createdBy === undefined ? 'owner' : row.createdBy
  );
}

function snapshot(chatSessionId: string, runtime: 'vm' | 'cf-container', project = P1) {
  insertD1('session_snapshots', {
    id: `snap-${chatSessionId}-${project}`,
    project_id: project,
    chat_session_id: chatSessionId,
    runtime,
  });
}

function wakeItems(projectId = P1, sessionId?: string) {
  const rows = d1Sqlite
    .prepare(`SELECT * FROM asks WHERE kind = 'error' AND project_id = ? ORDER BY created_at, id`)
    .all(projectId) as Record<string, unknown>[];
  return sessionId ? rows.filter((r) => r.source_session_id === sessionId) : rows;
}

function wakeMessages(sessionId = CHAT) {
  return sql
    .exec(
      `SELECT content FROM chat_messages
        WHERE session_id = ? AND role = 'system' AND content LIKE 'Wake failed:%'`,
      sessionId
    )
    .toArray();
}

function wakeMarkers(sessionId = CHAT) {
  return sql
    .exec(
      `SELECT kind, source, resolved_at FROM session_attention_markers
        WHERE session_id = ? AND kind = 'wake_failed'`,
      sessionId
    )
    .toArray();
}

function actionIds(item: Record<string, unknown>): string[] {
  const spec = JSON.parse(String(item.answer_spec_json)) as {
    type: string;
    actions?: Array<{ id: string }>;
  };
  return (spec.actions ?? []).map((a) => a.id);
}

let deliverySeq = 0;
/** One real wake-refused delivery to the chat, applied by the real claim runner. */
async function failWakeDelivery(sessionId = CHAT, senderTaskId = 'task-sender') {
  const deliveryId = `delivery-${++deliverySeq}`;
  acceptPromptDelivery(
    sql,
    {},
    {
      deliveryId,
      targetSessionId: sessionId,
      displayContent: 'Visible follow-up',
      deliveryContent: 'Enriched follow-up',
      senderType: 'human',
      senderId: 'owner',
      messageClass: 'deliver',
      sourceKind: 'user_followup',
      sourceTaskId: senderTaskId,
      ttlMs: config.ttlMs,
    },
    Date.now()
  );
  const claim = claimDuePromptDeliveries(sql, config, Date.now()).find(
    (c) => c.message.id === deliveryId
  );
  if (!claim) throw new Error(`delivery ${deliveryId} was not claimable`);
  const submit = vi.fn().mockResolvedValue({
    kind: 'failed',
    reason: 'wake_refused',
    error: 'The retained sleep snapshot has expired. (snapshot_expired)',
    runtimeIdentity: null,
    capabilities: null,
  });
  const result = await runPromptDeliveryClaim(
    sql,
    env,
    config,
    claim,
    { submit, reconcile: vi.fn() },
    hooks
  );
  expect(result).toMatchObject({ kind: 'failed', reason: 'wake_refused' });
}

/** The same trigger, entered at `raiseSessionWakeFailure` (assignee and fallback cases). */
function raise(
  sessionId = CHAT,
  taskId: string | null = 'task-sender',
  project: string | null = P1
) {
  return raiseSessionWakeFailure(
    sql,
    env,
    project,
    {
      sessionId,
      taskId,
      deliveryId: 'd-direct',
      reason: 'wake_refused',
      detail: 'Snapshot expired',
    },
    broadcastEvent
  );
}

function wakeReadyInput(chatSessionId = CHAT): SessionWakeReadyInput {
  return {
    projectId: P1,
    chatSessionId,
    workspaceId: 'workspace-new',
    agentSessionId: 'agent-1',
    fence: { runtime: 'vm', taskId: 'task-bound', recoveryAttemptId: 'attempt-1' },
  };
}

beforeEach(() => {
  deliverySeq = 0;
  createNotification.mockReset().mockResolvedValue({ id: 'n-1' });
  signalSessionWakeReady.mockReset().mockResolvedValue(0);
  broadcastEvent.mockReset();
  hooks.scheduleSummarySync.mockReset();

  d1Sqlite = new Database(':memory:');
  createAllSchemaTables(d1Sqlite, schema);
  // The shipped migrations, not the drizzle mirror: the partial indexes are under test too.
  d1Sqlite.exec('DROP TABLE asks');
  for (const file of ['0245_asks.sql', '0247_asks_questions.sql', '0248_asks_system_errors.sql'])
    applySqliteMigration(
      d1Sqlite,
      new URL(`../../../../src/db/migrations/${file}`, import.meta.url)
    );
  for (const id of ['owner', 'colleague', 'reviewer', 'outsider'])
    insertD1('users', { id, email: `${id}@x.test`, name: id, role: 'user', status: 'active' });
  insertD1('projects', { id: P1, user_id: 'owner', name: 'One', repository: 'o/one' });
  insertD1('projects', { id: P2, user_id: 'outsider', name: 'Two', repository: 'o/two' });
  for (const [project, user, role] of [
    [P1, 'owner', 'owner'],
    [P1, 'colleague', 'maintainer'],
    [P1, 'reviewer', 'maintainer'],
    [P2, 'outsider', 'owner'],
  ])
    insertD1('project_members', { project_id: project, user_id: user, role, status: 'active' });

  doSqlite = new Database(':memory:');
  sql = createSqlStorage(doSqlite);
  runMigrations(sql);

  // The registry holds the real worker port (the unit setup installs it too; installing it here
  // makes a missing port a failure of this file, not a silent fallback to the marker path).
  configureProjectDataPort('inboxErrors', inboxErrorsPort);

  env = {
    DATABASE: createSqliteD1(d1Sqlite),
    BASE_DOMAIN: 'example.test',
    ENCRYPTION_KEY: Buffer.alloc(32, 7).toString('base64'),
    NOTIFICATION: {
      idFromName: (name: string) => name,
      get: () => ({
        createNotification,
        claimNotificationDeduplication: vi.fn().mockResolvedValue(true),
      }),
    },
    PROJECT_DATA: {
      idFromName: (name: string) => name,
      get: () => ({ signalSessionWakeReady }),
    },
  } as unknown as Env;

  // The chat's own task is `task-bound`; `task-sender` belongs to someone else (a parent wake's
  // sender is a child task) and must never decide who is told.
  task('task-bound', 'owner', CHAT);
  task('task-sender', 'reviewer', 'chat-sender');
});

afterEach(() => {
  d1Sqlite.close();
  doSqlite.close();
});

describe('a failed wake delivery files one inbox item for the chat', () => {
  it('files one item for two failed wake deliveries of a VM chat: failure_count 2, one chat message, one notification', async () => {
    chat(CHAT);
    snapshot(CHAT, 'vm');

    await failWakeDelivery();
    const [first] = wakeItems();
    expect(first).toMatchObject({
      kind: 'error',
      status: 'open',
      project_id: P1,
      assignee_user_id: 'owner',
      dedupe_key: `error:wake:${CHAT}`,
      source_session_id: CHAT,
      // The chat's own task, not the task that sent the message.
      source_task_id: 'task-bound',
      failure_count: 1,
      title: "Couldn't wake “Fix the login bug”",
    });
    expect(JSON.parse(String(first!.links_json))).toEqual([
      { kind: 'chat', id: CHAT, label: null },
    ]);
    expect(wakeMessages()).toHaveLength(1);
    expect(createNotification).toHaveBeenCalledTimes(1);

    await failWakeDelivery();

    const items = wakeItems();
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ id: first!.id, status: 'open', failure_count: 2 });
    expect(actionIds(items[0]!)).toEqual(['wake', 'open_chat']);
    // The repeat updated the item in place: no second chat message, no second notification, no
    // fallback marker (liveness: the first failure's message is still the one in the transcript).
    expect(wakeMessages()).toHaveLength(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(wakeMarkers()).toEqual([]);
    expect(createNotification).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({
        type: 'error',
        projectId: P1,
        sessionId: CHAT,
        taskId: 'task-bound',
        actionUrl: `/projects/${P1}/inbox?item=${encodeURIComponent(`ask:${first!.id}`)}`,
      })
    );
  });

  it('offers Wake for a VM chat and only Open chat for an Instant chat, on the same trigger', async () => {
    chat(CHAT);
    snapshot(CHAT, 'vm');
    chat(OTHER_CHAT, { topic: 'Instant session' });
    snapshot(OTHER_CHAT, 'cf-container');
    task('task-instant', 'owner', OTHER_CHAT);

    await failWakeDelivery(CHAT);
    await failWakeDelivery(OTHER_CHAT);

    const vm = wakeItems(P1, CHAT);
    const instant = wakeItems(P1, OTHER_CHAT);
    expect(vm).toHaveLength(1);
    expect(instant).toHaveLength(1);
    expect(actionIds(vm[0]!)).toEqual(['wake', 'open_chat']);
    // An Instant chat wakes when it gets a message: a Wake button would always refuse.
    expect(actionIds(instant[0]!)).toEqual(['open_chat']);
    expect(instant[0]).toMatchObject({
      source_task_id: 'task-instant',
      dedupe_key: `error:wake:${OTHER_CHAT}`,
    });
  });

  it('treats a chat with no recorded snapshot runtime as a VM chat', async () => {
    chat(CHAT);
    await failWakeDelivery();
    expect(actionIds(wakeItems()[0]!)).toEqual(['wake', 'open_chat']);
  });

  it('does not read another project’s snapshot for the same chat id', async () => {
    chat(CHAT);
    snapshot(CHAT, 'cf-container', P2);
    await failWakeDelivery();
    expect(actionIds(wakeItems()[0]!)).toEqual(['wake', 'open_chat']);
  });
});

describe('when no item can be filed, the chat keeps its own marker', () => {
  it('writes a wake_failed marker and no asks row for a chat with no task bound to it', async () => {
    chat(CHAT);
    // The only task of the project is bound to a different chat.
    d1Sqlite
      .prepare(`UPDATE tasks SET chat_session_id = 'chat-elsewhere' WHERE id = 'task-bound'`)
      .run();

    const result = await raise();

    expect(wakeItems()).toEqual([]);
    expect(wakeMarkers()).toEqual([
      expect.objectContaining({ kind: 'wake_failed', source: 'session_wake', resolved_at: null }),
    ]);
    // Liveness: the failure is still visible in the chat, and no notification was sent for an item
    // that does not exist.
    expect(wakeMessages()).toHaveLength(1);
    expect(result).toMatchObject({ inserted: true });
    expect(createNotification).not.toHaveBeenCalled();
  });

  it('falls back to one marker for repeat failures of an unbound chat', async () => {
    chat(CHAT);
    d1Sqlite.prepare(`UPDATE tasks SET chat_session_id = NULL WHERE id = 'task-bound'`).run();

    await raise();
    const again = await raise();

    expect(wakeMarkers()).toHaveLength(1);
    expect(wakeMessages()).toHaveLength(1);
    expect(again).toMatchObject({ inserted: false });
    expect(wakeItems()).toEqual([]);
  });

  it('falls back to the marker when nobody can be addressed (no creator, no task owner, no project owner)', async () => {
    chat(CHAT, { createdBy: null });
    d1Sqlite.prepare(`UPDATE tasks SET user_id = NULL WHERE id = 'task-bound'`).run();
    d1Sqlite.prepare(`UPDATE projects SET user_id = NULL WHERE id = ?`).run(P1);

    await raise();

    expect(wakeItems()).toEqual([]);
    expect(wakeMarkers()).toHaveLength(1);
    expect(wakeMessages()).toHaveLength(1);
  });

  it('files an item and no marker when the same chat does have a task bound (control)', async () => {
    chat(CHAT);

    await raise();

    expect(wakeItems()).toHaveLength(1);
    expect(wakeMarkers()).toEqual([]);
  });
});

describe('an archived chat files nothing', () => {
  it('files no item, marker, message or notification for an archived chat, and does for a live one', async () => {
    chat('chat-archived', { status: 'archived' });
    task('task-archived', 'owner', 'chat-archived');
    chat(CHAT, { status: 'sleeping' });

    const archived = await raise('chat-archived');
    const live = await raise(CHAT);

    expect(archived).toEqual({ askId: null, messageId: null, inserted: false });
    expect(wakeItems(P1, 'chat-archived')).toEqual([]);
    expect(wakeMarkers('chat-archived')).toEqual([]);
    expect(wakeMessages('chat-archived')).toEqual([]);
    // Liveness: the same trigger on a live chat filed its item, so the archived case is not
    // "nothing works".
    expect(live).toMatchObject({ inserted: true });
    expect(wakeItems(P1, CHAT)).toHaveLength(1);
    expect(createNotification).toHaveBeenCalledTimes(1);
  });
});

describe('who is told about a failed wake', () => {
  it('addresses the chat’s creator, even when the bound task and the project belong to others', async () => {
    chat(CHAT, { createdBy: 'colleague' });

    await raise(CHAT, 'task-sender');

    const [item] = wakeItems();
    expect(item).toMatchObject({ assignee_user_id: 'colleague', source_task_id: 'task-bound' });
    expect(createNotification).toHaveBeenCalledTimes(1);
    expect(createNotification.mock.calls[0]![0]).toBe('colleague');
  });

  it('addresses the owner of the chat’s own task when the chat has no recorded creator', async () => {
    chat(CHAT, { createdBy: null });
    d1Sqlite.prepare(`UPDATE tasks SET user_id = 'colleague' WHERE id = 'task-bound'`).run();

    await raise(CHAT, 'task-sender');

    // Not the project owner ('owner'), and not the sender task's owner ('reviewer').
    expect(wakeItems()).toEqual([expect.objectContaining({ assignee_user_id: 'colleague' })]);
  });

  it('addresses the project owner when the chat has no creator and its task has no owner', async () => {
    chat(CHAT, { createdBy: null });
    d1Sqlite.prepare(`UPDATE tasks SET user_id = NULL WHERE id = 'task-bound'`).run();

    await raise(CHAT, 'task-sender');

    expect(wakeItems()).toEqual([expect.objectContaining({ assignee_user_id: 'owner' })]);
  });

  it('never addresses the owner of the task that sent the undelivered message', async () => {
    // The sender task ('reviewer') is an active member who could receive the item, so a regression
    // to "the sending task's owner" would file it for them.
    chat(CHAT, { createdBy: null });
    d1Sqlite.prepare(`UPDATE tasks SET user_id = 'colleague' WHERE id = 'task-bound'`).run();

    await raise(CHAT, 'task-sender');

    const items = wakeItems();
    expect(items).toHaveLength(1);
    expect(items[0]!.assignee_user_id).toBe('colleague');
    expect(items[0]!.assignee_user_id).not.toBe('reviewer');
  });
});

describe('a chat that wakes closes its failed-wake item', () => {
  async function recoveredChatFixture() {
    chat(CHAT);
    snapshot(CHAT, 'vm');
    chat(OTHER_CHAT, { topic: 'Another chat' });
    task('task-other', 'owner', OTHER_CHAT);
    await failWakeDelivery(CHAT);
    await failWakeDelivery(OTHER_CHAT);
    // A foreign project's item for the SAME chat id: scoping is by project.
    task('task-foreign', 'outsider', CHAT, P2);
    const foreign = await inboxErrorsPort.fileWakeFailure(env as never, {
      projectId: P2,
      sessionId: CHAT,
      createdByUserId: 'outsider',
      topic: 'Foreign',
    });
    expect(foreign).toMatchObject({ created: true });
  }

  it('closes it as recovered and releases the dedupe key when the real wake-ready signal runs', async () => {
    await recoveredChatFixture();
    expect(wakeItems(P1, CHAT)).toEqual([
      expect.objectContaining({ status: 'open', dedupe_key: `error:wake:${CHAT}` }),
    ]);

    await signalSessionWakeReadyBestEffort(env, wakeReadyInput(CHAT));

    const [closed] = wakeItems(P1, CHAT);
    expect(closed).toMatchObject({ status: 'done', dedupe_key: null });
    expect(JSON.parse(String(closed!.answer_json))).toEqual({ resolution: 'recovered' });
    expect(closed!.resolved_at).toEqual(expect.any(Number));
    // Liveness: the scheduling signal ran as well.
    expect(signalSessionWakeReady).toHaveBeenCalledTimes(1);
    // Controls: another chat of the project and the same chat id in another project stay open.
    expect(wakeItems(P1, OTHER_CHAT)).toEqual([
      expect.objectContaining({ status: 'open', dedupe_key: `error:wake:${OTHER_CHAT}` }),
    ]);
    expect(wakeItems(P2, CHAT)).toEqual([
      expect.objectContaining({ status: 'open', dedupe_key: `error:wake:${CHAT}` }),
    ]);
  });

  it('closes it even when the ProjectData scheduling signal fails', async () => {
    await recoveredChatFixture();
    signalSessionWakeReady.mockRejectedValue(new Error('ProjectData unavailable'));

    await expect(signalSessionWakeReadyBestEffort(env, wakeReadyInput(CHAT))).resolves.toBe(false);

    expect(wakeItems(P1, CHAT)[0]).toMatchObject({ status: 'done', dedupe_key: null });
  });

  it('files a new item, not a revived one, when the recovered chat fails to wake again', async () => {
    await recoveredChatFixture();
    await signalSessionWakeReadyBestEffort(env, wakeReadyInput(CHAT));
    const [recovered] = wakeItems(P1, CHAT);

    await failWakeDelivery(CHAT);

    const items = wakeItems(P1, CHAT);
    expect(items).toHaveLength(2);
    const fresh = items.find((item) => item.id !== recovered!.id)!;
    expect(fresh).toMatchObject({
      status: 'open',
      failure_count: 1,
      dedupe_key: `error:wake:${CHAT}`,
    });
    expect(items.find((item) => item.id === recovered!.id)).toMatchObject({ status: 'done' });
    // The new failure is new news: one more notification and one more chat message.
    expect(wakeMessages(CHAT)).toHaveLength(2);
  });

  it('leaves an item alone when a different chat wakes (control)', async () => {
    await recoveredChatFixture();

    await signalSessionWakeReadyBestEffort(env, wakeReadyInput('chat-unrelated'));

    expect(wakeItems(P1, CHAT)[0]).toMatchObject({ status: 'open' });
    expect(wakeItems(P1, OTHER_CHAT)[0]).toMatchObject({ status: 'open' });
  });
});

describe('the chat list ranks a chat with an open wake item as needing attention', () => {
  const NOW = Date.now();

  function summary(id: string, row: { lastMessageAt: number; project?: string }) {
    insertD1('session_summaries', {
      id,
      project_id: row.project ?? P1,
      user_id: 'owner',
      status: 'active',
      topic: id,
      message_count: 1,
      started_at: row.lastMessageAt,
      last_message_at: row.lastMessageAt,
      created_at: row.lastMessageAt,
      updated_at: row.lastMessageAt,
      created_by_user_id: 'owner',
    });
  }

  function indexQuery(project = P1) {
    return {
      projectId: project,
      status: null,
      limit: 2,
      offset: 0,
      createdByUserId: null,
      includeLive: true,
    };
  }

  async function listedIds(project = P1): Promise<string[]> {
    const read = await listSessionsFromIndex(env, indexQuery(project));
    if (!('result' in read)) throw new Error(`index miss: ${read.missReason}`);
    return read.result.sessions.map((s) => String(s.id));
  }

  beforeEach(() => {
    // The wake-failed chat is the OLDEST of three live chats and the page holds two.
    summary(CHAT, { lastMessageAt: NOW - 3_000_000 });
    summary('quiet-a', { lastMessageAt: NOW - 2_000_000 });
    summary('quiet-b', { lastMessageAt: NOW - 1_000_000 });
    insertD1('session_index_coverage', {
      project_id: P1,
      synced_at: NOW,
      session_count: 3,
      complete: 1,
    });
    chat(CHAT);
    snapshot(CHAT, 'vm');
    task('task-foreign', 'outsider', CHAT, P2);
  });

  it('reports wake_failed attention and ranks the chat into the list while its item is open, and not after it closes', async () => {
    // Liveness and baseline: with no item, the oldest chat is paged out.
    expect(await listedIds()).toEqual(['quiet-b', 'quiet-a']);

    await failWakeDelivery(CHAT);

    const open = await readOpenQuestionAttention(env.DATABASE, { projectId: P1, now: NOW });
    expect(open.get(CHAT)).toMatchObject({
      kind: 'wake_failed',
      source: 'session_wake',
      markerId: wakeItems(P1, CHAT)[0]!.id,
    });
    expect(open.has('quiet-a')).toBe(false);
    const read = await listSessionsFromIndex(env, indexQuery());
    if (!('result' in read)) throw new Error(`index miss: ${read.missReason}`);
    const listed = read.result.sessions.find((s) => s.id === CHAT);
    expect(read.result.sessions.map((s) => s.id).sort()).toEqual([CHAT, 'quiet-a', 'quiet-b']);
    expect(listed).toMatchObject({ attention: expect.objectContaining({ kind: 'wake_failed' }) });

    await signalSessionWakeReadyBestEffort(env, wakeReadyInput(CHAT));

    const closed = await readOpenQuestionAttention(env.DATABASE, { projectId: P1, now: NOW });
    expect(closed.has(CHAT)).toBe(false);
    expect(await listedIds()).toEqual(['quiet-b', 'quiet-a']);
  });

  it('does not count another project’s open wake item for the same chat id', async () => {
    // Attack: an open wake item exists, but in project P2 for a chat that shares the id.
    const foreign = await inboxErrorsPort.fileWakeFailure(env as never, {
      projectId: P2,
      sessionId: CHAT,
      createdByUserId: 'outsider',
      topic: 'Foreign',
    });
    expect(foreign).toMatchObject({ created: true });

    const readP1 = await readOpenQuestionAttention(env.DATABASE, { projectId: P1, now: NOW });
    expect(readP1.has(CHAT)).toBe(false);
    expect(await listedIds(P1)).toEqual(['quiet-b', 'quiet-a']);
    // Owner control: the foreign project does see its own item.
    const readP2 = await readOpenQuestionAttention(env.DATABASE, { projectId: P2, now: NOW });
    expect(readP2.get(CHAT)).toMatchObject({ kind: 'wake_failed' });
  });
});
