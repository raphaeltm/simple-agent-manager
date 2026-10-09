import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { OperationError, operationErrorHttpStatus } from '../../../src/operations/errors';
import { getPlatformOperationLimits } from '../../../src/operations/limits';
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
import { operationInputJsonSchema, operations } from '../../../src/operations/registry';
import type { Actor, OperationContext } from '../../../src/operations/types';
import { runWorkspaceOperation } from '../../../src/operations/workspace-adapter';
import { getMcpLimits } from '../../../src/routes/mcp/_helpers';
import { handleGetPeerAgentOutput } from '../../../src/routes/mcp/workspace-tools-direct';
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
      schema.taskStatusEvents,
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
    sqlite
      .prepare(
        'INSERT INTO tasks (id, project_id, user_id, title, description, status, priority, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)'
      )
      .run(
        'idea-other',
        otherProjectId,
        ownerId,
        'Other project idea',
        'Secret',
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

  it('records an idea status change without inventing a reason', async () => {
    await samIdeaUpdate.run(ctx(), { projectId, ideaId: 'idea-owner', status: 'ready' });
    expect(
      sqlite
        .prepare('SELECT from_status, to_status, reason FROM task_status_events WHERE task_id = ?')
        .get('idea-owner')
    ).toEqual({ from_status: 'draft', to_status: 'ready', reason: null });
  });

  it('rejects non-finite numeric input before reaching storage', async () => {
    await expect(samTasksList.run(ctx(), { projectId, limit: Number.NaN })).rejects.toMatchObject({
      code: 'invalid_input',
    });
    await expect(
      samIdeaCreate.run(ctx(), { projectId, title: 'Bad priority', priority: Infinity })
    ).rejects.toMatchObject({ code: 'invalid_input' });
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

  it('resource reads enforce the requested project, with owner controls in both projects', async () => {
    await expect(samTaskGet.run(ctx(), { projectId, taskId: 'idea-owner' })).resolves.toMatchObject(
      { id: 'idea-owner' }
    );
    await expect(samTaskGet.run(ctx(), { projectId, taskId: 'idea-other' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      samTaskGet.run(ctx(ownerId, otherProjectId), {
        projectId: otherProjectId,
        taskId: 'idea-other',
      })
    ).resolves.toMatchObject({ id: 'idea-other' });

    await expect(samIdeaGet.run(ctx(), { projectId, ideaId: 'idea-owner' })).resolves.toMatchObject(
      { ideaId: 'idea-owner' }
    );
    await expect(samIdeaGet.run(ctx(), { projectId, ideaId: 'idea-other' })).rejects.toMatchObject({
      code: 'not_found',
    });
    await expect(
      samIdeaGet.run(ctx(ownerId, otherProjectId), {
        projectId: otherProjectId,
        ideaId: 'idea-other',
      })
    ).resolves.toMatchObject({ ideaId: 'idea-other' });

    const ownerTasks = await samTasksList.run(ctx(), { projectId, include_own: true });
    expect(ownerTasks.tasks.map((task) => task.id)).toEqual(['idea-owner']);
    const otherTasks = await samTasksList.run(ctx(ownerId, otherProjectId), {
      projectId: otherProjectId,
      include_own: true,
    });
    expect(otherTasks.tasks.map((task) => task.id)).toEqual(['idea-other']);
  });

  it('workspace adapter rejects an explicit project mismatch with a matching owner control', async () => {
    const token = {
      userId: ownerId,
      projectId,
      workspaceId: 'workspace-1',
      taskId: 'current-task',
    } as McpTokenData;
    const control = await runWorkspaceOperation(
      'get_idea',
      51,
      { projectId, ideaId: 'idea-owner' },
      token,
      env
    );
    expect(control.result).toBeDefined();
    const attack = await runWorkspaceOperation(
      'get_idea',
      52,
      { projectId: otherProjectId, ideaId: 'idea-other' },
      token,
      env
    );
    expect(attack.error).toMatchObject({
      code: -32602,
      message: 'Project does not match workspace token',
    });
  });

  it('peer output keeps its workspace response shape while using task get', async () => {
    const token = {
      userId: ownerId,
      projectId,
      workspaceId: 'workspace-1',
      taskId: 'current-task',
    } as McpTokenData;
    const response = await handleGetPeerAgentOutput(60, { taskId: 'idea-owner' }, token, env);
    expect(JSON.stringify(response)).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 60,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  id: 'idea-owner',
                  title: 'Owner idea',
                  status: 'draft',
                  description: 'Content',
                  summary: null,
                  branch: null,
                },
                null,
                2
              ),
            },
          ],
        },
      })
    );
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
    const actualTasks = await runWorkspaceOperation(
      'list_tasks',
      41,
      { include_own: true },
      token,
      env
    );
    expect(JSON.stringify(actualTasks)).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 41,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  tasks: [
                    {
                      id: 'idea-owner',
                      title: 'Owner idea',
                      status: 'draft',
                      priority: 0,
                      descriptionSnippet: 'Content',
                      outputBranch: null,
                      outputPrUrl: null,
                      outputSummary: null,
                      updatedAt: '2026-10-09',
                    },
                  ],
                  count: 1,
                },
                null,
                2
              ),
            },
          ],
        },
      })
    );

    const actualIdea = await runWorkspaceOperation(
      'get_idea',
      42,
      { ideaId: 'idea-owner' },
      token,
      env
    );
    expect(JSON.stringify(actualIdea)).toBe(
      JSON.stringify({
        jsonrpc: '2.0',
        id: 42,
        result: {
          content: [
            {
              type: 'text',
              text: JSON.stringify(
                {
                  ideaId: 'idea-owner',
                  title: 'Owner idea',
                  content: 'Content',
                  contentLength: 7,
                  priority: 0,
                  status: 'draft',
                  createdAt: '2026-10-09',
                  updatedAt: '2026-10-09',
                },
                null,
                2
              ),
            },
          ],
        },
      })
    );

    // Frozen workspace fixtures cover the remaining response families. The JSON-RPC
    // envelope and pretty-printed text are part of the agent-facing contract.
    const expectWorkspaceText = async (
      name: string,
      id: number,
      params: Record<string, unknown>,
      payload: unknown
    ) => {
      const response = await runWorkspaceOperation(name, id, params, token, env);
      expect(JSON.stringify(response)).toBe(
        JSON.stringify({
          jsonrpc: '2.0',
          id,
          result: { content: [{ type: 'text', text: JSON.stringify(payload, null, 2) }] },
        })
      );
    };
    await expectWorkspaceText(
      'get_session_messages',
      43,
      { sessionId: 'chat-1' },
      {
        sessionId: 'chat-1',
        topic: 'Test chat',
        taskId: null,
        messages: [],
        messageCount: 0,
        hasMore: false,
      }
    );
    await expectWorkspaceText(
      'list_ideas',
      44,
      {},
      {
        ideas: [
          {
            ideaId: 'idea-owner',
            title: 'Owner idea',
            contentSnippet: 'Content',
            priority: 0,
            createdAt: '2026-10-09',
            updatedAt: '2026-10-09',
          },
        ],
        count: 1,
      }
    );
    await expectWorkspaceText(
      'update_idea',
      45,
      { ideaId: 'idea-owner', title: 'Renamed' },
      {
        updated: true,
        ideaId: 'idea-owner',
        updatedFields: ['title'],
      }
    );
    await expectWorkspaceText(
      'search_knowledge',
      46,
      { query: 'needle' },
      {
        results: [],
        count: 0,
        query: 'needle',
        queryTruncated: false,
        queryLimits: { maxLength: 4096, maxTerms: 40, maxTermLength: 48 },
      }
    );
  });
});

describe('operation registry contract', () => {
  it('uses the same configurable limits as the workspace tool catalog', () => {
    const env = {
      MCP_IDEA_LIST_MAX: '27',
      MCP_MESSAGE_LIST_LIMIT: '31',
      MCP_TASK_LIST_LIMIT: '12',
      MCP_TASK_DETAIL_RECENT_MESSAGE_LIMIT: '7',
      MCP_MESSAGE_SEARCH_LIMIT: '11',
    } as Env;
    const platform = getPlatformOperationLimits(env);
    const workspace = getMcpLimits(env);
    for (const [name, value] of Object.entries(platform)) {
      if (name in workspace) expect(workspace[name as keyof typeof workspace]).toBe(value);
    }
    expect(platform.taskDetailRecentMessageLimit).toBe(7);
    expect(platform.messageSearchLimit).toBe(11);
  });
  it('exports eighteen stable operations and JSON Schema inputs', () => {
    expect(operations.map((operation) => operation.name)).toEqual([
      'sam_task_get',
      'sam_tasks_list',
      'sam_chat_read',
      'sam_chats_search',
      'sam_ideas_search',
      'sam_idea_get',
      'sam_idea_create',
      'sam_idea_update',
      'sam_knowledge_search',
      'sam_profiles_list',
      'sam_projects_list',
      'sam_inbox_get',
      'sam_project_get',
      'sam_chats_list',
      'sam_chat_start',
      'sam_chat_send',
      'sam_agent_answer',
      'sam_work_stop',
    ]);
    expect(operationInputJsonSchema(samTaskGet)).toMatchObject({
      type: 'object',
      properties: { projectId: { type: 'string' }, taskId: { type: 'string' } },
      required: ['projectId', 'taskId'],
    });
  });

  it('maps typed errors to HTTP statuses', () => {
    const codes: OperationError['code'][] = [
      'invalid_input',
      'not_found',
      'forbidden',
      'conflict',
      'rate_limited',
      'unavailable',
    ];
    expect(codes.map((code) => operationErrorHttpStatus(new OperationError(code, code)))).toEqual([
      400, 404, 403, 409, 429, 503,
    ]);
  });
});
