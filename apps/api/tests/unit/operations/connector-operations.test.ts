import { readFileSync } from 'node:fs';

import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import {
  samAgentAnswer,
  samChatSend,
  samChatsList,
  samChatStart,
  samInboxGet,
  samProjectGet,
  samProjectsList,
  samWorkStop,
} from '../../../src/operations/connector-operations';
import {
  samChatRead,
  samIdeasSearch,
  samProfilesList,
  samTasksList,
} from '../../../src/operations/platform-operations';
import type { OperationContext } from '../../../src/operations/types';
import * as projectData from '../../../src/services/project-data';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  send: vi.fn(),
  submit: vi.fn(),
  answer: vi.fn(),
  stop: vi.fn(),
  snapshot: vi.fn(),
  notifications: vi.fn(),
  getSession: vi.fn(),
}));
vi.mock('../../../src/services/send-chat', () => ({ sendChat: mocks.send }));
vi.mock('../../../src/services/submit-task', () => ({ submitTask: mocks.submit }));
vi.mock('../../../src/routes/chat-acp-interactions', () => ({
  answerAgentInteraction: mocks.answer,
}));
vi.mock('../../../src/routes/chat', () => ({ answerAttention: mocks.answer }));
vi.mock('../../../src/routes/chat-stop', () => ({ stopChat: mocks.stop }));
vi.mock('../../../src/services/acp-interaction-store', () => ({
  snapshotInteractions: mocks.snapshot,
  getInteractionDetail: vi.fn().mockResolvedValue({
    detail: { message: 'Allow shell command?', options: [{ id: 'allow', name: 'Allow once' }] },
  }),
}));
vi.mock('../../../src/services/task-terminal-cleanup', () => ({
  cleanupTerminalTaskResourcesOrThrow: vi.fn().mockResolvedValue(undefined),
}));
vi.mock('../../../src/services/project-data', () => ({
  getSession: mocks.getSession,
  getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
  recordActivityEvent: vi.fn().mockResolvedValue(undefined),
}));

// External runtime boundaries are mocked. Identity, current memberships, queries,
// admission, receipts and audit use actual SQLite and the production functions.
describe('connector operations current membership and creator authority', () => {
  let sqlite: Database.Database;
  let env: Env;
  function ctx(userId = 'owner'): OperationContext {
    return {
      env,
      actor: {
        userId,
        via: 'connector',
        clientName: 'Claude',
        scopes: new Set(['sam.read', 'sam.write']),
      },
      requestId: 'test',
      execCtx: { waitUntil: vi.fn() } as unknown as ExecutionContext,
    };
  }
  beforeEach(() => {
    vi.clearAllMocks();
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.users,
      schema.projects,
      schema.projectMembers,
      schema.tasks,
      schema.agentProfiles,
      schema.taskStatusEvents,
      schema.sessionSummaries,
      schema.triggers,
      schema.platformSettings,
    ]);
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0191_connector_execution.sql', import.meta.url),
        'utf8'
      )
    );
    sqlite.exec(
      readFileSync(
        new URL('../../../src/db/migrations/0189_cli_operation_receipts.sql', import.meta.url),
        'utf8'
      )
    );
    sqlite
      .prepare('INSERT INTO users (id,name,email) VALUES (?,?,?)')
      .run('owner', 'Owner', 'owner@example.com');
    for (const userId of ['viewer', 'colleague', 'outsider', 'unknown'])
      sqlite
        .prepare('INSERT INTO users (id,name,email) VALUES (?,?,?)')
        .run(userId, userId, `${userId}@example.com`);
    for (const id of ['project', 'secret'])
      sqlite.prepare('INSERT INTO projects (id,name) VALUES (?,?)').run(id, id);
    const member = sqlite.prepare(
      "INSERT INTO project_members (project_id,user_id,role,status) VALUES (?,?,?,'active')"
    );
    member.run('project', 'owner', 'owner');
    member.run('project', 'viewer', 'viewer');
    member.run('project', 'colleague', 'maintainer');
    member.run('secret', 'outsider', 'owner');
    const session = sqlite.prepare(
      'INSERT INTO session_summaries (id,project_id,created_by_user_id,updated_at,attention_json) VALUES (?,?,?,?,?)'
    );
    session.run('chat', 'project', 'owner', 20, '{"message":"Needs approval"}');
    session.run('other-chat', 'secret', 'outsider', 21, '{"message":"Secret"}');
    sqlite
      .prepare(
        "INSERT INTO tasks (id,project_id,user_id,title,status,chat_session_id,updated_at) VALUES ('task','project','owner','Work','completed','chat','2026-10-09')"
      )
      .run();
    mocks.getSession.mockImplementation(
      async (_env: unknown, projectId: string, sessionId: string) =>
        projectId === 'project' && sessionId === 'chat'
          ? { id: sessionId, createdByUserId: 'owner' }
          : null
    );
    mocks.snapshot.mockResolvedValue({
      pending: [{ interactionId: 'permission', kind: 'permission' }],
      settled: [],
      cursor: null,
    });
    mocks.notifications.mockResolvedValue({
      notifications: [
        { id: 'visible', projectId: 'project', title: 'Visible' },
        { id: 'secret', projectId: 'secret', title: 'Secret' },
      ],
    });
    mocks.send.mockResolvedValue({ accepted: true });
    mocks.submit.mockResolvedValue({ taskId: 'task', sessionId: 'chat', status: 'queued' });
    mocks.answer.mockResolvedValue({ accepted: true });
    mocks.stop.mockResolvedValue({ status: 'stopped' });
    env = {
      DATABASE: createSqliteD1(sqlite),
      BASE_DOMAIN: 'example.com',
      NOTIFICATION: {
        idFromName: (id: string) => id,
        get: () => ({ listNotifications: mocks.notifications }),
      },
    } as unknown as Env;
  });
  afterEach(() => sqlite.close());
  it('lists current memberships, excludes removed users and never trusts project ownership', async () => {
    expect((await samProjectsList.run(ctx(), {})).projects.map((p) => p.id)).toEqual(['project']);
    expect((await samProjectsList.run(ctx('unknown'), {})).projects).toEqual([]);
    sqlite.prepare("UPDATE project_members SET status='removed' WHERE user_id='owner'").run();
    expect((await samProjectsList.run(ctx(), {})).projects).toEqual([]);
  });
  it('overview requires project membership (attack and owner control)', async () => {
    await expect(
      samProjectGet.run(ctx('outsider'), { projectId: 'project' })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(await samProjectGet.run(ctx(), { projectId: 'project' })).toMatchObject({
      id: 'project',
      tasks: [{ id: 'task' }],
    });
  });
  it('cross-project chats filter revoked memberships and paginate tied activity without duplicates', async () => {
    sqlite
      .prepare(
        "INSERT INTO session_summaries (id,project_id,created_by_user_id,updated_at) VALUES ('chat-b','project','owner',20)"
      )
      .run();
    const first = await samChatsList.run(ctx(), { limit: 1 });
    expect(first.chats.map((c) => c.id)).toEqual(['chat-b']);
    expect(
      (
        await samChatsList.run(ctx(), { limit: 1, cursor: first.nextCursor ?? undefined })
      ).chats.map((c) => c.id)
    ).toEqual(['chat']);
    expect((await samChatsList.run(ctx('unknown'), {})).chats).toEqual([]);
    expect((await samChatsList.run(ctx('colleague'), {})).chats[0]?.attention).toBeNull();
  });
  it('inbox filters other projects and limits private interaction details to creator', async () => {
    const inbox = await samInboxGet.run(ctx(), {});
    expect(inbox.pending).toHaveLength(1);
    expect(inbox.notifications.map((n) => n.id)).toEqual(['visible']);
    expect(inbox.pending[0]?.link).toContain('/projects/project/chat/chat');
    mocks.snapshot.mockClear();
    expect((await samInboxGet.run(ctx('colleague'), {})).pending).toEqual([]);
    expect(mocks.snapshot).not.toHaveBeenCalled();
  });
  const writes = [
    {
      name: 'start',
      run: (c: OperationContext) =>
        samChatStart.run(c, { projectId: 'project', message: 'Inspect the code' }),
    },
    {
      name: 'send',
      run: (c: OperationContext) =>
        samChatSend.run(c, { projectId: 'project', sessionId: 'chat', content: 'Continue' }),
    },
    {
      name: 'answer',
      run: (c: OperationContext) =>
        samAgentAnswer.run(c, {
          projectId: 'project',
          sessionId: 'chat',
          markerId: 'marker',
          answer: 'Yes',
        }),
    },
    {
      name: 'stop',
      run: (c: OperationContext) => samWorkStop.run(c, { projectId: 'project', sessionId: 'chat' }),
    },
  ];
  for (const write of writes)
    it(`${write.name} denies outsider/viewer/read-only scope and accepts owner`, async () => {
      await expect(write.run(ctx('outsider'))).rejects.toMatchObject({ code: 'not_found' });
      await expect(write.run(ctx('viewer'))).rejects.toMatchObject({ code: 'forbidden' });
      const readOnly = ctx();
      readOnly.actor.scopes = new Set(['sam.read']);
      await expect(write.run(readOnly)).rejects.toMatchObject({ code: 'forbidden' });
      await expect(write.run(ctx())).resolves.toBeDefined();
    });
  for (const write of writes.slice(1))
    it(`${write.name} denies a same-project noncreator`, async () => {
      await expect(write.run(ctx('colleague'))).rejects.toMatchObject({ code: 'forbidden' });
      await expect(write.run(ctx())).resolves.toBeDefined();
    });
  it('cancels an owned queued task before its chat is created and rejects a peer task', async () => {
    sqlite
      .prepare(
        "INSERT INTO tasks (id,project_id,user_id,title,status) VALUES ('queued-task','project','owner','Pending','queued')"
      )
      .run();
    await expect(
      samWorkStop.run(ctx('colleague'), { projectId: 'project', taskId: 'queued-task' })
    ).rejects.toMatchObject({ code: 'not_found' });
    expect(
      await samWorkStop.run(ctx(), { projectId: 'project', taskId: 'queued-task' })
    ).toMatchObject({ status: 'cancelled', taskId: 'queued-task' });
    expect(
      sqlite.prepare("SELECT status,error_message FROM tasks WHERE id='queued-task'").get()
    ).toMatchObject({ status: 'cancelled', error_message: null });
  });
  it('inbox cursor independently advances all sources without repeating exhausted sources', async () => {
    sqlite.exec(
      "INSERT INTO session_summaries (id,project_id,created_by_user_id,updated_at,attention_json) VALUES ('older','project','owner',10,'{}'); INSERT INTO tasks (id,project_id,user_id,title,status,updated_at) VALUES ('older-task','project','owner','Older failure','failed','2026-10-08')"
    );
    mocks.notifications
      .mockResolvedValueOnce({
        notifications: [{ id: 'n1', projectId: 'project', title: 'First' }],
        nextCursor: '100',
      })
      .mockResolvedValueOnce({
        notifications: [{ id: 'n2', projectId: 'project', title: 'Second' }],
        nextCursor: null,
      });
    mocks.snapshot.mockResolvedValue({
      pending: [
        { interactionId: 'one', kind: 'permission' },
        { interactionId: 'two', kind: 'permission' },
      ],
      settled: [],
      cursor: null,
    });
    const first = await samInboxGet.run(ctx(), { limit: 1 });
    expect(first.pending.map((row) => row.sessionId)).toEqual(['chat']);
    expect(first.pending[0]?.interactions).toHaveLength(2);
    expect(first.tasks.map((row) => row.id)).toEqual(['task']);
    expect(first.nextCursor).not.toBeNull();
    const second = await samInboxGet.run(ctx(), {
      limit: 1,
      cursor: first.nextCursor ?? undefined,
    });
    expect(second.pending.map((row) => row.sessionId)).toEqual(['older']);
    expect(second.tasks.map((row) => row.id)).toEqual(['older-task']);
    expect(second.notifications.map((row) => row.id)).toEqual(['n2']);
    expect(second.nextCursor).toBeNull();
    expect(mocks.notifications).toHaveBeenLastCalledWith('owner', {
      filter: 'unread',
      limit: 1,
      cursor: '100',
    });
    await expect(samInboxGet.run(ctx(), { cursor: 'invalid' })).rejects.toMatchObject({
      code: 'invalid_input',
    });
  });
  it('profiles have bounded cursor paging and name filtering', async () => {
    sqlite.exec(
      "INSERT INTO agent_profiles (id,project_id,user_id,name,agent_type) VALUES ('profile-a','project','owner','Code Alpha','openai-codex'),('profile-b','project','owner','Code Beta','openai-codex'),('other-profile','secret','outsider','Private','openai-codex')"
    );
    const first = await samProfilesList.run(ctx(), {
      projectId: 'project',
      limit: 1,
      query: 'Code',
    });
    expect(first.profiles.map((row) => row.id)).toEqual(['profile-a']);
    const second = await samProfilesList.run(ctx(), {
      projectId: 'project',
      limit: 1,
      query: 'Code',
      cursor: 'nextCursor' in first ? (first.nextCursor ?? undefined) : undefined,
    });
    expect(second.profiles.map((row) => row.id)).toEqual(['profile-b']);
    expect(second).toMatchObject({ nextCursor: null });
  });
  it('cross-project task and idea lists exclude foreign/revoked projects and support cursor paging', async () => {
    sqlite.exec(
      "INSERT INTO tasks (id,project_id,user_id,title,status,updated_at) VALUES ('idea-a','project','owner','Idea A','draft','2026-10-09'),('idea-b','project','owner','Idea B','draft','2026-10-09'),('private','secret','outsider','Private','draft','2026-10-10')"
    );
    const first = await samIdeasSearch.run(ctx(), { limit: 1 });
    expect(first.ideas.map((idea) => ('ideaId' in idea ? idea.ideaId : ''))).toEqual(['idea-b']);
    const second = await samIdeasSearch.run(ctx(), {
      limit: 1,
      cursor: 'nextCursor' in first ? (first.nextCursor ?? undefined) : undefined,
    });
    expect(second.ideas.map((idea) => ('ideaId' in idea ? idea.ideaId : ''))).toEqual(['idea-a']);
    expect((await samTasksList.run(ctx(), {})).tasks.map((task) => task.id)).not.toContain(
      'private'
    );
    sqlite.prepare("UPDATE project_members SET status='removed' WHERE user_id='owner'").run();
    expect((await samTasksList.run(ctx(), {})).tasks).toEqual([]);
    expect((await samIdeasSearch.run(ctx(), {})).ideas).toEqual([]);
  });
  it('transcripts page with exact cursor and distinguish concise from detailed content', async () => {
    const text = 'x'.repeat(2500);
    vi.mocked(projectData.getMessages).mockResolvedValue({
      messages: [{ id: 'message', role: 'assistant', content: text, createdAt: 10, sequence: 2 }],
      hasMore: true,
    });
    const first = await samChatRead.run(ctx(), { projectId: 'project', sessionId: 'chat' });
    expect(first.messages[0]?.content.length).toBe(2000);
    expect(first).toMatchObject({ untrustedContent: true, nextCursor: '[10,2,"message"]' });
    const detailed = await samChatRead.run(ctx(), {
      projectId: 'project',
      sessionId: 'chat',
      cursor: '[10,2,"message"]',
      response_format: 'detailed',
      includeToolPayloads: true,
    });
    expect(detailed.messages[0]?.content).toBe(text);
    expect(projectData.getMessages).toHaveBeenLastCalledWith(
      env,
      'project',
      'chat',
      51,
      { createdAt: 10, sequence: 2, id: 'message' },
      null,
      undefined
    );
  });
  it('replays a successful start by key without calling provisioning twice and denies after membership removal', async () => {
    const c = ctx();
    c.idempotencyKey = 'same-request';
    await samChatStart.run(c, { projectId: 'project', message: 'Work' });
    await samChatStart.run(c, { projectId: 'project', message: 'Work' });
    expect(mocks.submit).toHaveBeenCalledTimes(1);
    sqlite.prepare("UPDATE project_members SET status='removed' WHERE user_id='owner'").run();
    await expect(
      samChatStart.run(c, { projectId: 'project', message: 'Work' })
    ).rejects.toMatchObject({ code: 'not_found' });
  });
});
