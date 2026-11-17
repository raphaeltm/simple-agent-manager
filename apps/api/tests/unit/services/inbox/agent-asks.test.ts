/**
 * Agent inbox tools (inbox slice D), on a real SQL engine (`.claude/rules/28`, `.claude/rules/11`):
 * filing asks and reviews through the shared operations, the answer shapes, idempotency, similar
 * items, link checks, the blocking-only "paused" readers, and tenancy for update / cancel / get
 * (each attack case paired with an owner control). Replaced edges only: ProjectData RPCs (live
 * events, chat/policy/knowledge lookups, prompt delivery) and the agent-wake policy.
 */
import {
  type AgentInboxSource,
  answerInboxItem,
  cancelAgentAsk,
  fileAgentAsk,
  fileAgentReview,
  getAgentAsk,
  listAgentAsks,
  type OperationContext,
  OperationError,
  updateAgentAsk,
} from '@simple-agent-manager/operations';
import { hasOpenQuestionAsk, readOpenQuestionAttention } from '@simple-agent-manager/worker-core';
import Database from 'better-sqlite3';
import { beforeEach, describe, expect, it, vi } from 'vitest';

const edges = vi.hoisted(() => ({
  acceptPromptDelivery: vi.fn(),
  recordQuestionAsked: vi.fn(),
  recordQuestionWithdrawn: vi.fn(),
  getSession: vi.fn(),
  getPolicy: vi.fn(),
  getKnowledgeEntity: vi.fn(),
  authorizeAgentWake: vi.fn(),
  createNotification: vi.fn(),
}));
vi.mock('../../../../src/services/project-data', async () => ({
  ...(await vi.importActual<typeof import('../../../../src/services/project-data')>(
    '../../../../src/services/project-data'
  )),
  acceptPromptDelivery: edges.acceptPromptDelivery,
  recordQuestionAsked: edges.recordQuestionAsked,
  recordQuestionWithdrawn: edges.recordQuestionWithdrawn,
  getSession: edges.getSession,
  getPolicy: edges.getPolicy,
  getKnowledgeEntity: edges.getKnowledgeEntity,
}));
vi.mock('../../../../src/services/agent-wake-authorization', () => ({
  authorizeAgentWake: edges.authorizeAgentWake,
}));

import { closeQuestionAsksForHumanMessage } from '@simple-agent-manager/project-data/internal/do/question-asks';

import * as schema from '../../../../src/db/schema';
import type { Env } from '../../../../src/env';
import { createOperationPorts } from '../../../../src/operation-ports';
import { __resetAdminSettingsCacheForTest } from '../../../../src/services/admin-settings';
import { buildInboxAskPrompt } from '../../../../src/services/inbox/ask-notice';
import { fileQuestionAsk } from '../../../../src/services/inbox/question-asks';
import { runInboxAskSweep } from '../../../../src/services/inbox/sweep';
import {
  applySqliteMigration,
  createAllSchemaTables,
  createSqliteD1,
} from '../../../helpers/sqlite-d1';

const P1 = 'proj-1';
const P2 = 'proj-2';
let sqlite: Database.Database;
let env: Env;

function insert(table: string, row: Record<string, unknown>) {
  const keys = Object.keys(row);
  sqlite
    .prepare(`INSERT INTO ${table} (${keys.join(',')}) VALUES (${keys.map(() => '?').join(',')})`)
    .run(...Object.values(row));
}

function askRow(id: string) {
  return sqlite.prepare('SELECT * FROM asks WHERE id = ?').get(id) as Record<string, unknown>;
}

function setting(key: string, value: string) {
  insert('platform_settings', { key, value, updated_at: '2026-11-16T00:00:00Z' });
}

function ctxFor(userId: string, projectId: string): OperationContext {
  return {
    env,
    ports: createOperationPorts(env),
    requestId: 'r',
    actor: {
      userId,
      via: 'workspace-agent',
      scopes: new Set(['sam.read', 'sam.write']),
      workspace: { workspaceId: 'ws-1', taskId: 'task-1', projectId },
    },
  };
}

function webCtx(userId: string): OperationContext {
  return { ...ctxFor(userId, P1), actor: { userId, via: 'web', scopes: new Set(['sam.write']) } };
}

/** The agent of chat-1 in project 1 (the owner control). */
const chat1: AgentInboxSource = {
  projectId: P1,
  sessionId: 'chat-1',
  taskId: 'task-1',
  workspaceId: 'ws-1',
  userId: 'owner',
};
/** Another chat in the same project. */
const chat3: AgentInboxSource = { ...chat1, sessionId: 'chat-3', taskId: 'task-3' };
/** An agent in project 2. */
const foreign: AgentInboxSource = {
  projectId: P2,
  sessionId: 'chat-2',
  taskId: 'task-2',
  workspaceId: 'ws-2',
  userId: 'outsider',
};

const ask = (
  source = chat1,
  input: Parameters<typeof fileAgentAsk>[2] = { title: 'Which region?' }
) => fileAgentAsk(ctxFor(source.userId, source.projectId), source, input);

async function rejects(promise: Promise<unknown>, code: string, message?: RegExp) {
  const error = await promise.then(
    () => null,
    (cause: unknown) => cause
  );
  expect(error).toBeInstanceOf(OperationError);
  expect((error as OperationError).code).toBe(code);
  if (message) expect((error as OperationError).message).toMatch(message);
}

beforeEach(() => {
  __resetAdminSettingsCacheForTest();
  for (const edge of Object.values(edges)) edge.mockReset();
  edges.acceptPromptDelivery.mockResolvedValue({ message: { id: 'd' } });
  edges.recordQuestionAsked.mockResolvedValue(undefined);
  edges.recordQuestionWithdrawn.mockResolvedValue(undefined);
  edges.getSession.mockImplementation(async (_env: Env, projectId: string, sessionId: string) =>
    projectId === P1 && ['chat-1', 'chat-3'].includes(sessionId) ? { id: sessionId } : null
  );
  edges.getPolicy.mockImplementation(async (_env: Env, projectId: string, id: string) =>
    projectId === P1 && id === 'pol-1' ? { id } : null
  );
  edges.getKnowledgeEntity.mockImplementation(async (_env: Env, projectId: string, id: string) =>
    projectId === P1 && id === 'ent-1' ? { id } : null
  );
  edges.authorizeAgentWake.mockResolvedValue({
    writer: { ownerUserId: 'owner', role: 'owner' },
    wake: { allowed: true },
  });
  edges.createNotification.mockResolvedValue({ id: 'notif-1' });
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec('DROP TABLE asks');
  for (const file of ['0245_asks.sql', '0247_asks_questions.sql', '0248_asks_system_errors.sql']) {
    applySqliteMigration(sqlite, new URL(`../../../../src/db/migrations/${file}`, import.meta.url));
  }
  env = {
    DATABASE: createSqliteD1(sqlite),
    BASE_DOMAIN: 'example.test',
    NOTIFICATION: {
      idFromName: (name: string) => name,
      get: () => ({ createNotification: edges.createNotification }),
    },
  } as unknown as Env;
  for (const id of ['owner', 'outsider'])
    insert('users', { id, email: `${id}@x.test`, name: id, role: 'user', status: 'active' });
  insert('projects', { id: P1, user_id: 'owner', name: 'One', repository: 'acme/one' });
  insert('projects', { id: P2, user_id: 'outsider', name: 'Two', repository: 'acme/two' });
  insert('project_members', { project_id: P1, user_id: 'owner', role: 'owner', status: 'active' });
  insert('project_members', {
    project_id: P2,
    user_id: 'outsider',
    role: 'owner',
    status: 'active',
  });
  for (const [id, projectId, userId, chat] of [
    ['task-1', P1, 'owner', 'chat-1'],
    ['task-3', P1, 'owner', 'chat-3'],
    ['task-2', P2, 'outsider', 'chat-2'],
  ] as const) {
    insert('tasks', {
      id,
      project_id: projectId,
      user_id: userId,
      title: `Task ${id}`,
      status: 'in_progress',
      chat_session_id: chat,
    });
  }
});

describe('inbox_write ask', () => {
  it('files a blocking question with options, links and a group, pauses the chat and pushes', async () => {
    insert('tasks', {
      id: 'idea-1',
      project_id: P1,
      user_id: 'owner',
      title: 'Idea',
      status: 'draft',
      is_idea: 1,
    });
    const filed = await ask(chat1, {
      title: 'Which region should the deploy use?',
      why: 'EU keeps latency low for most users.',
      options: ['eu', 'us', 'eu'],
      links: [
        { kind: 'idea', id: 'idea-1', label: 'Plan' },
        { kind: 'pr', url: 'https://github.com/acme/one/pull/7' },
      ],
      groupKey: 'deploy',
    });
    expect(filed).toMatchObject({
      kind: 'question',
      blocking: true,
      created: true,
      sessionId: 'chat-1',
    });
    expect(filed.ref).toBe(`ask:${filed.id}`);
    const row = askRow(filed.id);
    expect(row).toMatchObject({
      project_id: P1,
      kind: 'question',
      blocking: 1,
      assignee_user_id: 'owner',
      title: 'Which region should the deploy use?',
      body_md: 'EU keeps latency low for most users.',
      group_key: 'deploy',
      source_session_id: 'chat-1',
      source_task_id: 'task-1',
      status: 'open',
      notification_id: 'notif-1',
    });
    expect(row.expires_at).not.toBeNull();
    expect(row.next_escalation_at).not.toBeNull();
    expect(JSON.parse(String(row.answer_spec_json))).toEqual({
      type: 'options',
      options: ['eu', 'us'],
      allowText: false,
    });
    expect(JSON.parse(String(row.links_json))).toEqual([
      { kind: 'idea', id: 'idea-1', label: 'Plan' },
      { kind: 'pr', id: 'https://github.com/acme/one/pull/7', label: null },
    ]);
    expect(edges.recordQuestionAsked).toHaveBeenCalledWith(
      env,
      P1,
      expect.objectContaining({ sessionId: 'chat-1', askId: filed.id, options: ['eu', 'us'] })
    );
    expect(edges.createNotification).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({
        type: 'needs_input',
        metadata: expect.objectContaining({ attentionMarkerId: filed.id }),
      })
    );
    expect(filed.notificationScheduled).toBe(true);
    // The chat reads as paused on a person.
    expect(
      await hasOpenQuestionAsk(env.DATABASE, {
        projectId: P1,
        sessionId: 'chat-1',
        taskId: 'task-1',
        now: Date.now(),
      })
    ).toBe(true);
  });

  it('files a non-blocking ask that never expires and does not pause the chat', async () => {
    const filed = await ask(chat1, { title: 'Prefer tabs or spaces?', blocking: false });
    const row = askRow(filed.id);
    expect(row).toMatchObject({ blocking: 0, expires_at: null, next_escalation_at: null });
    expect(edges.recordQuestionAsked).not.toHaveBeenCalled();
    // It still reaches the person.
    expect(edges.createNotification).toHaveBeenCalledOnce();
    const now = Date.now();
    expect(
      await hasOpenQuestionAsk(env.DATABASE, {
        projectId: P1,
        sessionId: 'chat-1',
        taskId: 'task-1',
        now,
      })
    ).toBe(false);
    expect((await readOpenQuestionAttention(env.DATABASE, { projectId: P1, now })).size).toBe(0);
    // Liveness: the same reader does see a blocking question.
    await ask(chat1, { title: 'Ship it?' });
    expect(
      (await readOpenQuestionAttention(env.DATABASE, { projectId: P1, now: Date.now() })).size
    ).toBe(1);
  });

  it('a chat message answers the blocking question and leaves the non-blocking ask open', async () => {
    const blocking = await ask(chat1, { title: 'Ship it?' });
    const later = await ask(chat1, { title: 'Rename later?', blocking: false });
    const closed = await closeQuestionAsksForHumanMessage(
      env as never,
      { projectId: P1, sessionId: 'chat-1', messageId: 'm-1', messageCreatedAt: Date.now() + 1 },
      () => undefined
    );
    expect(closed).toBe(1);
    expect(askRow(blocking.id).status).toBe('answered');
    expect(askRow(later.id).status).toBe('open');
  });

  it('confirm is Yes/No; text is the default; one answer shape only', async () => {
    const confirm = await ask(chat1, { title: 'Delete the branch?', answer: 'confirm' });
    expect(JSON.parse(String(askRow(confirm.id).answer_spec_json))).toEqual({
      type: 'options',
      options: ['Yes', 'No'],
      allowText: false,
    });
    const text = await ask(chat1, { title: 'What should the banner say?' });
    expect(JSON.parse(String(askRow(text.id).answer_spec_json))).toEqual({ type: 'text' });
    await rejects(
      ask(chat1, { title: 'Both?', options: ['a'], answer: 'text' }),
      'invalid_input',
      /one answer shape/
    );
  });

  it('refuses a missing, multi-line or over-long title', async () => {
    await rejects(ask(chat1, { title: '  ' }), 'invalid_input', /title is required/);
    await rejects(ask(chat1, { title: 'One.\nTwo.' }), 'invalid_input', /one line/);
    setting('inbox.titleMaxChars', '40');
    __resetAdminSettingsCacheForTest();
    await rejects(ask(chat1, { title: 'x'.repeat(41) }), 'invalid_input', /40 characters/);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM asks').get()).toEqual({ n: 0 });
  });

  it('a retried call with the same idempotency key files once; another chat may reuse the key', async () => {
    const first = await ask(chat1, { title: 'Which region?', idempotencyKey: 'k1' });
    const retry = await ask(chat1, { title: 'Which region?', idempotencyKey: 'k1' });
    expect(retry).toMatchObject({ id: first.id, created: false, notificationScheduled: false });
    expect(edges.createNotification).toHaveBeenCalledOnce();
    const other = await ask(chat3, { title: 'Which region?', idempotencyKey: 'k1' });
    expect(other.id).not.toBe(first.id);
    expect(sqlite.prepare('SELECT COUNT(*) AS n FROM asks').get()).toEqual({ n: 2 });
  });

  it('returns similar open items of the project: same group or close title, never itself', async () => {
    const grouped = await ask(chat3, { title: 'Pick a colour for the logo', groupKey: 'brand' });
    const close = await ask(chat3, { title: 'Which deploy region should we use?' });
    await ask(chat3, { title: 'Unrelated question about billing' });
    const filed = await ask(chat1, {
      title: 'Which region should the deploy use?',
      groupKey: 'brand',
    });
    expect(filed.similar.map((item) => [item.ref, item.match])).toEqual([
      [grouped.ref, 'group'],
      [close.ref, 'title'],
    ]);
    expect(filed.similar.every((item) => item.ref !== filed.ref)).toBe(true);
    // The cap is an admin setting; 0 turns the check off.
    setting('inbox.similarMatchesMax', '0');
    __resetAdminSettingsCacheForTest();
    expect((await ask(chat1, { title: 'Which deploy region now?' })).similar).toEqual([]);
  });

  it('accepts each link kind of this project and refuses one from another project', async () => {
    insert('tasks', {
      id: 'idea-1',
      project_id: P1,
      user_id: 'owner',
      title: 'I',
      status: 'draft',
      is_idea: 1,
    });
    insert('tasks', {
      id: 'idea-2',
      project_id: P2,
      user_id: 'outsider',
      title: 'I',
      status: 'draft',
      is_idea: 1,
    });
    insert('project_files', {
      id: 'file-1',
      project_id: P1,
      filename: 'a.md',
      mime_type: 'text/markdown',
      size_bytes: 1,
      r2_key: 'k',
      uploaded_by: 'owner',
      created_at: '2026-11-16T00:00:00Z',
      updated_at: '2026-11-16T00:00:00Z',
    });
    insert('nodes', { id: 'node-1', user_id: 'owner', name: 'n', status: 'running' });
    insert('workspaces', {
      id: '01ABCWS',
      node_id: 'node-1',
      project_id: P1,
      user_id: 'owner',
      name: 'w',
      repository: 'acme/one',
      branch: 'main',
      status: 'running',
    });
    const filed = await ask(chat1, {
      title: 'Review these?',
      links: [
        { kind: 'idea', id: 'idea-1' },
        { kind: 'file', id: 'file-1' },
        { kind: 'chat', id: 'chat-3' },
        { kind: 'policy', id: 'pol-1' },
        { kind: 'knowledge', id: 'ent-1' },
        { kind: 'pr', url: 'https://github.com/acme/one/pull/1' },
        { kind: 'preview', url: 'https://ws-01abcws--3000.example.test/' },
      ],
    });
    expect(JSON.parse(String(askRow(filed.id).links_json))).toHaveLength(7);
    for (const link of [
      { kind: 'idea' as const, id: 'idea-2' },
      { kind: 'chat' as const, id: 'chat-2' },
      { kind: 'policy' as const, id: 'pol-9' },
      { kind: 'pr' as const, url: 'https://github.com/acme/two/pull/1' },
      { kind: 'preview' as const, url: 'https://ws-01abcws--3000.evil.test/' },
    ]) {
      await rejects(ask(chat1, { title: 'Link?', links: [link] }), 'invalid_input', /links\[0\]/);
    }
    await rejects(
      ask(chat1, {
        title: 'Link?',
        links: [{ kind: 'pr', url: 'http://github.com/acme/one/pull/1' }],
      }),
      'invalid_input',
      /https/
    );
    // A check that cannot run refuses the link rather than storing an unchecked reference.
    edges.getPolicy.mockRejectedValueOnce(new Error('DO down'));
    await rejects(
      ask(chat1, { title: 'Link?', links: [{ kind: 'policy', id: 'pol-1' }] }),
      'invalid_input',
      /could not be checked/
    );
  });
});

describe('cross-user isolation and pull request hosts', () => {
  it("an agent working for one member never sees another member's items or answers", async () => {
    insert('users', {
      id: 'colleague',
      email: 'c@x.test',
      name: 'c',
      role: 'user',
      status: 'active',
    });
    insert('project_members', {
      project_id: P1,
      user_id: 'colleague',
      role: 'maintainer',
      status: 'active',
    });
    insert('tasks', {
      id: 'task-c',
      project_id: P1,
      user_id: 'colleague',
      title: 'C',
      status: 'in_progress',
      chat_session_id: 'chat-c',
    });
    const colleague: AgentInboxSource = {
      ...chat1,
      sessionId: 'chat-c',
      taskId: 'task-c',
      userId: 'colleague',
    };
    const theirs = await ask(colleague, {
      title: 'Which region should the deploy use?',
      blocking: false,
    });
    await answerInboxItem(webCtx('colleague'), {
      projectId: P1,
      ref: theirs.ref,
      answer: 'secret plan',
    });
    const open = await ask(colleague, {
      title: 'Pick a colour for the logo',
      blocking: false,
      groupKey: 'brand',
    });

    const mine = await ask(chat1, {
      title: 'Which region should the deploy use?',
      groupKey: 'brand',
    });
    // Neither the close title nor the shared group reveals the colleague's item.
    expect(mine.similar).toEqual([]);
    const list = await listAgentAsks(ctxFor('owner', P1), chat1, { scope: 'project' });
    expect(list.items.map((item) => item.ref)).toEqual([mine.ref]);
    await rejects(getAgentAsk(ctxFor('owner', P1), chat1, { ref: theirs.ref }), 'not_found');
    await rejects(getAgentAsk(ctxFor('owner', P1), chat1, { ref: open.ref }), 'not_found');
    // Owner control: the colleague's own agent sees both, and the answer.
    expect(
      (await getAgentAsk(ctxFor('colleague', P1), colleague, { ref: theirs.ref })).answer
    ).toBe('secret plan');
    const theirList = await listAgentAsks(ctxFor('colleague', P1), colleague, { scope: 'project' });
    expect(theirList.items.map((item) => item.ref)).toEqual([open.ref]);
  });

  it("a pr link must be the project's repository host and a numbered pull request", async () => {
    for (const url of [
      'https://evil.example/acme/one/pull/1',
      'https://github.com/acme/one/issues/1',
      'https://github.com/acme/one/pull/1/../../two/pull/2',
      'https://user@github.com/acme/one/pull/1',
      'https://github.com:8443/acme/one/pull/1',
    ]) {
      await rejects(
        ask(chat1, { title: 'PR?', links: [{ kind: 'pr', url }] }),
        'invalid_input',
        /links\[0\]/
      );
    }
    // Owner control on the same project.
    const filed = await ask(chat1, {
      title: 'PR?',
      links: [{ kind: 'pr', url: 'https://github.com/Acme/One/pull/12/' }],
    });
    expect(JSON.parse(String(askRow(filed.id).links_json))).toHaveLength(1);
  });
});

describe('request_human_input alias', () => {
  it('files a blocking ask through the same operation: title, schedule, live chat, push and link', async () => {
    const filed = await fileQuestionAsk(env, {
      projectId: P1,
      sessionId: 'chat-1',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      userId: 'owner',
      context: 'Ship the fix now? Staging is green.',
      category: 'approval',
      options: ['Yes', 'No'],
    });
    expect(filed.notificationScheduled).toBe(true);
    expect(askRow(filed.id)).toMatchObject({
      kind: 'question',
      blocking: 1,
      title: 'Ship the fix now?',
      body_md: 'Ship the fix now? Staging is green.',
      category: 'approval',
      notification_id: 'notif-1',
      expires_at: filed.expiresAt,
    });
    expect(askRow(filed.id).next_escalation_at).not.toBeNull();
    expect(edges.recordQuestionAsked).toHaveBeenCalledWith(
      env,
      P1,
      expect.objectContaining({ askId: filed.id, options: ['Yes', 'No'] })
    );
    expect(edges.createNotification).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({
        type: 'needs_input',
        title: expect.stringMatching(/^Approval needed/),
        metadata: expect.objectContaining({ attentionMarkerId: filed.id, options: ['Yes', 'No'] }),
      })
    );
  });
});

describe('expiry', () => {
  it('a non-blocking ask and a review outlive the question window; a blocking ask expires', async () => {
    const later = await ask(chat1, { title: 'Rename later?', blocking: false });
    const review = await fileAgentReview(ctxFor('owner', P1), chat1, { title: 'Review the PR' });
    const blocking = await ask(chat1, { title: 'Ship it?' });
    // Far past every question limit (default 24 h hard limit).
    await runInboxAskSweep(env, Date.now() + 3 * 24 * 60 * 60_000);
    expect(askRow(later.id).status).toBe('open');
    expect(askRow(review.id).status).toBe('open');
    // Control: the sweep ran and expired the blocking question.
    expect(askRow(blocking.id).status).toBe('expired');
  });
});

describe('inbox_write review', () => {
  it('files a non-blocking review answered "Looks good" or with a reply, never expiring', async () => {
    const filed = await fileAgentReview(ctxFor('owner', P1), chat1, {
      title: 'Please review the pricing page PR',
      links: [{ kind: 'pr', url: 'https://github.com/acme/one/pull/9' }],
    });
    expect(askRow(filed.id)).toMatchObject({ kind: 'review', blocking: 0, expires_at: null });
    expect(JSON.parse(String(askRow(filed.id).answer_spec_json))).toEqual({ type: 'acknowledge' });
    expect(edges.createNotification).toHaveBeenCalledWith(
      'owner',
      expect.objectContaining({ title: expect.stringMatching(/^Review needed/) })
    );
    expect(edges.recordQuestionAsked).not.toHaveBeenCalled();

    const answered = await answerInboxItem(webCtx('owner'), { projectId: P1, ref: filed.ref });
    expect(answered).toMatchObject({ outcome: 'answered', agentNotified: true });
    const delivery = edges.acceptPromptDelivery.mock.calls[0]?.[2] as { deliveryContent: string };
    expect(delivery.deliveryContent).toMatch(/reviewed your inbox item .* it looks good/);
    expect(
      buildInboxAskPrompt(
        {
          id: 'a',
          projectId: P1,
          kind: 'review',
          title: 'T',
          status: 'answered',
          answerJson: JSON.stringify({ text: 'Fix the header' }),
          sourceSessionId: 'chat-1',
          sourceTaskId: 'task-1',
          sourceWorkspaceId: null,
          createdAt: 1,
          resolvedByUserId: 'owner',
          assigneeUserId: 'owner',
        },
        'answered'
      )
    ).toMatch(/replied:\n\nFix the header/);
  });
});

describe('update, cancel and get: tenancy', () => {
  it('owner control: the filing chat edits and cancels its own open item', async () => {
    const filed = await ask(chat1, { title: 'Old title' });
    await updateAgentAsk(ctxFor('owner', P1), chat1, {
      ref: filed.ref,
      title: 'New title',
      why: 'Because',
      links: [{ kind: 'chat', id: 'chat-3' }],
    });
    expect(askRow(filed.id)).toMatchObject({ title: 'New title', body_md: 'Because' });
    await cancelAgentAsk(ctxFor('owner', P1), chat1, {
      ref: filed.ref,
      reason: 'Found it in the docs',
    });
    const row = askRow(filed.id);
    expect(row).toMatchObject({ status: 'cancelled' });
    expect(row.notified_at).not.toBeNull();
    expect(JSON.parse(String(row.answer_json))).toEqual({ cancelReason: 'Found it in the docs' });
    // A blocking question stops pausing its chat.
    expect(edges.recordQuestionWithdrawn).toHaveBeenCalledWith(env, P1, {
      sessionId: 'chat-1',
      askId: filed.id,
    });
    // A closed item cannot be edited or cancelled again.
    await rejects(
      updateAgentAsk(ctxFor('owner', P1), chat1, { ref: filed.ref, title: 'x' }),
      'conflict'
    );
    await rejects(
      cancelAgentAsk(ctxFor('owner', P1), chat1, { ref: filed.ref, reason: 'x' }),
      'conflict'
    );
  });

  it('an agent in project 2 cannot update, cancel or read an item of project 1', async () => {
    const filed = await ask(chat1, { title: 'Mine' });
    const before = askRow(filed.id);
    // The foreign agent passes the real ref and even claims the owner's chat id.
    const forged = { ...foreign, sessionId: 'chat-1' };
    await rejects(
      updateAgentAsk(ctxFor('outsider', P2), forged, { ref: filed.ref, title: 'Hacked' }),
      'not_found'
    );
    await rejects(
      cancelAgentAsk(ctxFor('outsider', P2), forged, { ref: filed.ref, reason: 'x' }),
      'not_found'
    );
    await rejects(getAgentAsk(ctxFor('outsider', P2), foreign, { ref: filed.ref }), 'not_found');
    expect(
      (await listAgentAsks(ctxFor('outsider', P2), foreign, { scope: 'project' })).items
    ).toEqual([]);
    expect(askRow(filed.id)).toEqual(before);
    // Owner control on the same fixture.
    expect((await getAgentAsk(ctxFor('owner', P1), chat1, { ref: filed.ref })).title).toBe('Mine');
  });

  it("another chat of the same project can read but not update or cancel this chat's item", async () => {
    const filed = await ask(chat1, { title: 'Mine' });
    const before = askRow(filed.id);
    await rejects(
      updateAgentAsk(ctxFor('owner', P1), chat3, { ref: filed.ref, title: 'Hacked' }),
      'not_found'
    );
    await rejects(
      cancelAgentAsk(ctxFor('owner', P1), chat3, { ref: filed.ref, reason: 'x' }),
      'not_found'
    );
    expect(askRow(filed.id)).toEqual(before);
    expect(edges.recordQuestionWithdrawn).not.toHaveBeenCalled();
    const read = await getAgentAsk(ctxFor('owner', P1), chat3, { ref: filed.ref });
    expect(read).toMatchObject({ title: 'Mine', fromThisChat: false });
  });

  it('an agent cannot edit or cancel an error item SAM filed against its chat', async () => {
    insert('asks', {
      id: 'err-1',
      project_id: P1,
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      kind: 'error',
      blocking: 0,
      title: 'The chat could not wake',
      source_session_id: 'chat-1',
      source_task_id: 'task-1',
      status: 'open',
      created_at: 1,
      updated_at: 1,
    });
    await rejects(
      cancelAgentAsk(ctxFor('owner', P1), chat1, { ref: 'ask:err-1', reason: 'x' }),
      'not_found'
    );
    await rejects(
      updateAgentAsk(ctxFor('owner', P1), chat1, { ref: 'ask:err-1', title: 'x' }),
      'not_found'
    );
    expect(askRow('err-1').status).toBe('open');
  });

  it('lists open items from this chat or the project, and get returns the answer', async () => {
    const mine = await ask(chat1, { title: 'Mine', blocking: false });
    const theirs = await ask(chat3, { title: 'Theirs', blocking: false });
    const chatList = await listAgentAsks(ctxFor('owner', P1), chat1, {});
    expect(chatList.items.map((item) => item.ref)).toEqual([mine.ref]);
    const projectList = await listAgentAsks(ctxFor('owner', P1), chat1, { scope: 'project' });
    expect(projectList.items.map((item) => item.ref).sort()).toEqual([mine.ref, theirs.ref].sort());
    const limited = await listAgentAsks(ctxFor('owner', P1), chat1, { scope: 'project', limit: 1 });
    expect(limited).toMatchObject({ hasMore: true });
    expect(limited.items).toHaveLength(1);

    await answerInboxItem(webCtx('owner'), { projectId: P1, ref: mine.ref, answer: 'Spaces' });
    const read = await getAgentAsk(ctxFor('owner', P1), chat1, { ref: mine.ref });
    expect(read).toMatchObject({ status: 'answered', answer: 'Spaces', fromThisChat: true });
    expect((await listAgentAsks(ctxFor('owner', P1), chat1, {})).items).toEqual([]);
  });

  it('skips a malformed row in the list instead of failing it (rule 50)', async () => {
    const good = await ask(chat1, { title: 'Good', blocking: false });
    insert('asks', {
      id: 'bad-1',
      project_id: P1,
      assignee_kind: 'user',
      assignee_user_id: 'owner',
      kind: 'question',
      blocking: 0,
      title: 'Bad',
      links_json: 'not json',
      source_session_id: 'chat-1',
      status: 'open',
      created_at: 1,
      updated_at: 1,
    });
    const list = await listAgentAsks(ctxFor('owner', P1), chat1, {});
    expect(list.items.map((item) => item.ref)).toEqual([good.ref]);
    expect(list.skipped).toBe(1);
    await rejects(getAgentAsk(ctxFor('owner', P1), chat1, { ref: 'ask:bad-1' }), 'not_found');
  });
});
