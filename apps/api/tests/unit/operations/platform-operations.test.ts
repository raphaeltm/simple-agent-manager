import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { type OperationError } from '../../../src/operations/errors';
import {
  samChatRead,
  samChatsSearch,
  samIdeaCreate,
  samIdeaGet,
  samIdeasSearch,
  samIdeaUpdate,
  samKnowledgeSearch,
  samProfilesList,
  samTaskGet,
  samTasksList,
} from '../../../src/operations/platform-operations';
import type { Actor, OperationContext } from '../../../src/operations/types';
import { runWorkspaceOperation } from '../../../src/operations/workspace-adapter';
import { handleGetIdea } from '../../../src/routes/mcp/idea-tools';
import { handleListTasks } from '../../../src/routes/mcp/task-tools';
import type { McpTokenData } from '../../../src/services/mcp-token';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

vi.mock('../../../src/services/project-data', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/services/project-data')>();
  return {
    ...original,
    getSession: vi.fn().mockResolvedValue({ topic: 'Test chat', taskId: null }),
    getMessages: vi.fn().mockResolvedValue({ messages: [], hasMore: false }),
    searchMessagesWithArchiveMetadata: vi.fn().mockResolvedValue({
      results: [],
      query: { query: 'needle', queryTruncated: false },
      archiveSearch: { partial: false, complete: true },
      rootSearch: null,
    }),
    searchKnowledgeObservations: vi.fn().mockResolvedValue([]),
  };
});

const projectId = 'project-owner';
const otherProjectId = 'project-other';
const ownerId = 'owner';
const outsiderId = 'outsider';
const viewerId = 'viewer';

function actor(userId: string, workspaceProjectId = projectId): Actor {
  return {
    userId,
    via: 'workspace-agent',
    scopes: new Set(['sam.read', 'sam.write']),
    workspace: {
      workspaceId: 'workspace-1',
      taskId: 'current-task',
      projectId: workspaceProjectId,
    },
  };
}

describe('shared platform operation authorization on real SQLite', () => {
  let sqlite: Database.Database;
  let env: Env;
  let requestId = 0;

  function ctx(userId = ownerId, workspaceProjectId = projectId): OperationContext {
    return { env, actor: actor(userId, workspaceProjectId), requestId: String(++requestId) };
  }

  beforeEach(() => {
    sqlite = new Database(':memory:');
    createSchemaTables(sqlite, [
      schema.projects,
      schema.projectMembers,
      schema.tasks,
      schema.agentProfiles,
    ]);
    env = { DATABASE: createSqliteD1(sqlite) } as Env;
    sqlite.prepare('INSERT INTO projects (id) VALUES (?)').run(projectId);
    sqlite.prepare('INSERT INTO projects (id) VALUES (?)').run(otherProjectId);
    const member = sqlite.prepare(
      'INSERT INTO project_members (project_id, user_id, role, status) VALUES (?, ?, ?, ?)'
    );
    member.run(projectId, ownerId, 'owner', 'active');
    member.run(projectId, viewerId, 'viewer', 'active');
    member.run(otherProjectId, ownerId, 'owner', 'active');
    sqlite
      .prepare(
        'INSERT INTO tasks (id, project_id, user_id, title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'idea-owner',
        projectId,
        ownerId,
        'Owner idea',
        'Content',
        'draft',
        0,
        '2026-10-09',
        '2026-10-09'
      );
  });

  afterEach(() => sqlite.close());

  const reads = [
    {
      name: 'task get',
      run: (c: OperationContext, p: string) =>
        samTaskGet.run(c, { projectId: p, taskId: 'idea-owner' }),
    },
    {
      name: 'tasks list',
      run: (c: OperationContext, p: string) =>
        samTasksList.run(c, { projectId: p, include_own: true }),
    },
    {
      name: 'chat read',
      run: (c: OperationContext, p: string) =>
        samChatRead.run(c, { projectId: p, sessionId: 'chat-1' }),
    },
    {
      name: 'chats search',
      run: (c: OperationContext, p: string) =>
        samChatsSearch.run(c, { projectId: p, query: 'needle' }),
    },
    {
      name: 'ideas search',
      run: (c: OperationContext, p: string) => samIdeasSearch.run(c, { projectId: p }),
    },
    {
      name: 'idea get',
      run: (c: OperationContext, p: string) =>
        samIdeaGet.run(c, { projectId: p, ideaId: 'idea-owner' }),
    },
    {
      name: 'knowledge search',
      run: (c: OperationContext, p: string) =>
        samKnowledgeSearch.run(c, { projectId: p, query: 'needle' }),
    },
    {
      name: 'profiles list',
      run: (c: OperationContext, p: string) => samProfilesList.run(c, { projectId: p }),
    },
  ];

  for (const operation of reads) {
    it(`${operation.name}: owner succeeds and cross-user access fails`, async () => {
      await expect(operation.run(ctx(), projectId)).resolves.toBeDefined();
      await expect(operation.run(ctx(outsiderId), projectId)).rejects.toMatchObject({
        code: 'not_found',
      } satisfies Partial<OperationError>);
    });

    it(`${operation.name}: workspace project mismatch fails while matching project succeeds`, async () => {
      await expect(operation.run(ctx(), projectId)).resolves.toBeDefined();
      await expect(operation.run(ctx(ownerId), otherProjectId)).rejects.toMatchObject({
        code: 'forbidden',
      } satisfies Partial<OperationError>);
    });
  }

  it('idea create: owner succeeds and viewer cannot write', async () => {
    await expect(samIdeaCreate.run(ctx(), { projectId, title: 'New idea' })).resolves.toMatchObject(
      { status: 'draft' }
    );
    await expect(
      samIdeaCreate.run(ctx(viewerId), { projectId, title: 'Denied idea' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(
      sqlite.prepare('SELECT count(*) AS count FROM tasks WHERE title = ?').get('Denied idea')
    ).toEqual({ count: 0 });
  });

  it('idea update: owner succeeds and viewer cannot write', async () => {
    await expect(
      samIdeaUpdate.run(ctx(), { projectId, ideaId: 'idea-owner', title: 'Updated' })
    ).resolves.toMatchObject({ updated: true });
    await expect(
      samIdeaUpdate.run(ctx(viewerId), { projectId, ideaId: 'idea-owner', title: 'Denied' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    expect(sqlite.prepare('SELECT title FROM tasks WHERE id = ?').get('idea-owner')).toEqual({
      title: 'Updated',
    });
  });

  it('idea writes reject a mismatched workspace project with an owner path control', async () => {
    await expect(samIdeaCreate.run(ctx(), { projectId, title: 'Allowed' })).resolves.toBeDefined();
    await expect(
      samIdeaCreate.run(ctx(), { projectId: otherProjectId, title: 'Denied' })
    ).rejects.toMatchObject({ code: 'forbidden' });
    await expect(
      samIdeaUpdate.run(ctx(), { projectId, ideaId: 'idea-owner', title: 'Allowed update' })
    ).resolves.toBeDefined();
    await expect(
      samIdeaUpdate.run(ctx(), {
        projectId: otherProjectId,
        ideaId: 'idea-owner',
        title: 'Denied update',
      })
    ).rejects.toMatchObject({ code: 'forbidden' });
  });

  it('scope checks pair each rejected path with an owner control', async () => {
    await expect(samTasksList.run(ctx(), { projectId })).resolves.toBeDefined();
    const noRead = ctx();
    noRead.actor.scopes = new Set(['sam.write']);
    await expect(samTasksList.run(noRead, { projectId })).rejects.toMatchObject({
      code: 'forbidden',
    });

    await expect(samIdeaCreate.run(ctx(), { projectId, title: 'Allowed' })).resolves.toBeDefined();
    const noWrite = ctx();
    noWrite.actor.scopes = new Set(['sam.read']);
    await expect(samIdeaCreate.run(noWrite, { projectId, title: 'Denied' })).rejects.toMatchObject({
      code: 'forbidden',
    });
  });

  it('workspace adapter preserves representative JSON-RPC response bytes', async () => {
    const token = {
      userId: ownerId,
      projectId,
      workspaceId: 'workspace-1',
      taskId: 'current-task',
    } as McpTokenData;
    const expectedTasks = await handleListTasks(41, { include_own: true }, token, env);
    const actualTasks = await runWorkspaceOperation(
      'list_tasks',
      41,
      { include_own: true },
      token,
      env
    );
    expect(JSON.stringify(actualTasks)).toBe(JSON.stringify(expectedTasks));

    const expectedIdea = await handleGetIdea(42, { ideaId: 'idea-owner' }, token, env);
    const actualIdea = await runWorkspaceOperation(
      'get_idea',
      42,
      { ideaId: 'idea-owner' },
      token,
      env
    );
    expect(JSON.stringify(actualIdea)).toBe(JSON.stringify(expectedIdea));
  });
});
