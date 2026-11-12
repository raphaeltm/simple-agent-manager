/**
 * The workspace `sam-mcp` tools and the /sam agent tools share one operation function for
 * archived tool payloads, resource history, session listing and mission creation
 * (`src/operations/workspace-history.ts`, `session-list.ts`, `missions.ts`). These tests drive
 * each surface's real handler and pin both halves of the contract: the shared read/write is
 * the same, and each surface keeps its own authorization, wording and output shape.
 */
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import type { McpTokenData } from '../../../src/services/mcp-token';
import { createAllSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const mocks = vi.hoisted(() => ({
  getSession: vi.fn(),
  getArchivedToolPayloads: vi.fn(),
  listSessions: vi.fn(),
  resourceHistory: vi.fn(),
  startOrchestration: vi.fn(),
}));

vi.mock('../../../src/services/project-data', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-data')>()),
  getSession: mocks.getSession,
  getArchivedToolPayloads: mocks.getArchivedToolPayloads,
  listSessions: mocks.listSessions,
}));
vi.mock('../../../src/services/workspace-resource-history', () => ({
  getWorkspaceResourceHistory: mocks.resourceHistory,
}));
vi.mock('../../../src/services/project-orchestrator', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../src/services/project-orchestrator')>()),
  startOrchestration: mocks.startOrchestration,
}));

const { handleGetArchivedToolPayloads, handleGetResourceHistory, handleListSessions } =
  await import('../../../src/routes/mcp/session-tools');
const { handleCreateMission } = await import('../../../src/routes/mcp/mission-tools');
const { getArchivedToolPayloads } =
  await import('../../../src/durable-objects/sam-session/tools/get-archived-tool-payloads');
const { getResourceHistory } =
  await import('../../../src/durable-objects/sam-session/tools/get-resource-history');
const { listSessions } =
  await import('../../../src/durable-objects/sam-session/tools/list-sessions');
const { createMission } =
  await import('../../../src/durable-objects/sam-session/tools/create-mission');

const PROJECT = 'project-1';
const OWNER = 'owner';

let sqlite: Database.Database;
let env: Env;

function token(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    projectId: PROJECT,
    taskId: 'task-1',
    userId: OWNER,
    workspaceId: 'ws-1',
    chatSessionId: 'chat-1',
    agentSessionId: 'agent-1',
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

function samCtx(userId = OWNER) {
  return { env, userId } as never;
}

function mcpPayload(response: unknown): unknown {
  const result = (response as { result?: { content: { text: string }[] } }).result;
  if (!result) throw new Error(`expected a JSON-RPC result, got ${JSON.stringify(response)}`);
  return JSON.parse(result.content[0]!.text);
}

function mcpError(response: unknown): string | undefined {
  return (response as { error?: { message: string } }).error?.message;
}

beforeEach(() => {
  vi.clearAllMocks();
  sqlite = new Database(':memory:');
  createAllSchemaTables(sqlite, schema);
  sqlite.exec(`
    INSERT INTO users (id, name, email) VALUES ('owner','Owner','o@example.com'), ('other','Other','x@example.com');
    INSERT INTO projects (id, name, repository, user_id) VALUES ('${PROJECT}', 'Project', 'acme/app', '${OWNER}');
  `);
  env = { DATABASE: createSqliteD1(sqlite), BASE_DOMAIN: 'example.test' } as unknown as Env;
  mocks.getSession.mockResolvedValue({ id: 'chat-1' });
  mocks.getArchivedToolPayloads.mockResolvedValue({ payloads: [{ messageId: 'm1' }] });
  mocks.startOrchestration.mockResolvedValue(undefined);
});

afterEach(() => sqlite.close());

describe('archived tool payloads: one shared read for both surfaces', () => {
  it('resolves the same page size from the shared limits on both surfaces', async () => {
    env = { ...env, MCP_ARCHIVED_TOOL_PAYLOAD_LIST_MAX: '5' } as Env;

    const mcp = await handleGetArchivedToolPayloads(
      1,
      { sessionId: 'chat-1', limit: 99 },
      token(),
      env
    );
    const sam = await getArchivedToolPayloads(
      { projectId: PROJECT, sessionId: 'chat-1', limit: 99 },
      samCtx()
    );

    expect(mcpPayload(mcp)).toEqual({ payloads: [{ messageId: 'm1' }] });
    expect(sam).toEqual({ payloads: [{ messageId: 'm1' }] });
    expect(mocks.getArchivedToolPayloads.mock.calls.map((call) => call.slice(1))).toEqual([
      [PROJECT, { sessionId: 'chat-1', limit: 5 }],
      [PROJECT, { sessionId: 'chat-1', limit: 5 }],
    ]);
  });

  it('defaults the page size, and keeps each surface’s handling of limit 0', async () => {
    await handleGetArchivedToolPayloads(1, { messageId: 'm1' }, token(), env);
    await getArchivedToolPayloads({ projectId: PROJECT, messageId: 'm1' }, samCtx());
    // MCP clamps an explicit 0 to 1; /sam has always treated a falsy limit as "use the default".
    await handleGetArchivedToolPayloads(1, { messageId: 'm1', limit: 0 }, token(), env);
    await getArchivedToolPayloads({ projectId: PROJECT, messageId: 'm1', limit: 0 }, samCtx());

    expect(mocks.getArchivedToolPayloads.mock.calls.map((call) => call[2].limit)).toEqual([
      10, 10, 1, 10,
    ]);
  });

  it('reports an unknown session in each surface’s own words and reads nothing', async () => {
    mocks.getSession.mockResolvedValue(null);

    const mcp = await handleGetArchivedToolPayloads(1, { sessionId: 'nope' }, token(), env);
    const sam = await getArchivedToolPayloads({ projectId: PROJECT, sessionId: 'nope' }, samCtx());

    expect(mcpError(mcp)).toBe('Session not found in this project');
    expect(sam).toEqual({ error: 'Session not found in this project.' });
    expect(mocks.getArchivedToolPayloads).not.toHaveBeenCalled();
  });

  it('keeps /sam authorization: a project the caller does not own is refused before any read', async () => {
    const sam = await getArchivedToolPayloads(
      { projectId: PROJECT, sessionId: 'chat-1' },
      samCtx('other')
    );

    expect(sam).toEqual({ error: 'Project not found or not owned by you.' });
    expect(mocks.getSession).not.toHaveBeenCalled();
    expect(mocks.getArchivedToolPayloads).not.toHaveBeenCalled();
  });
});

describe('resource history: one shared read and one set of notes', () => {
  beforeEach(() => {
    mocks.resourceHistory.mockResolvedValue({ summary: { sampleCount: 3 }, chunks: [] });
  });

  it('returns the same scope, history and notes from both surfaces', async () => {
    const mcp = mcpPayload(
      await handleGetResourceHistory(1, { workspaceId: 'ws-1', chunkId: 'c1' }, token(), env)
    );
    const sam = await getResourceHistory(
      { projectId: PROJECT, workspaceId: 'ws-1', chunkId: 'c1' },
      samCtx()
    );

    expect(sam).toEqual(mcp);
    expect(mcp).toMatchObject({
      scope: { projectId: PROJECT, sessionId: null, taskId: null, workspaceId: 'ws-1' },
      summary: { sampleCount: 3 },
    });
    expect((mcp as { notes: string[] }).notes).toHaveLength(5);
    expect(mocks.resourceHistory.mock.calls.map((call) => call[1])).toEqual([
      {
        projectId: PROJECT,
        sessionId: null,
        taskId: null,
        workspaceId: 'ws-1',
        detailChunkId: 'c1',
      },
      {
        projectId: PROJECT,
        sessionId: null,
        taskId: null,
        workspaceId: 'ws-1',
        detailChunkId: 'c1',
      },
    ]);
  });
});

describe('list sessions: one shared read and summary shape', () => {
  beforeEach(() => {
    mocks.listSessions.mockResolvedValue({
      sessions: [
        {
          id: 's1',
          topic: 'Topic',
          status: 'active',
          messageCount: 4,
          taskId: 't1',
          workspaceId: 'w1',
          startedAt: 1,
          endedAt: null,
          secretInternalField: 'not exposed',
        },
      ],
      total: 1,
      hasMore: false,
    });
  });

  it('maps the same eight fields and keeps each surface’s extra output', async () => {
    const summary = {
      id: 's1',
      topic: 'Topic',
      status: 'active',
      messageCount: 4,
      taskId: 't1',
      workspaceId: 'w1',
      startedAt: 1,
      endedAt: null,
    };
    const mcp = mcpPayload(
      await handleListSessions(1, { status: 'active', limit: 3 }, token(), env)
    );
    const sam = await listSessions(
      { projectId: PROJECT, status: 'active', taskId: ' t1 ', limit: 3 },
      samCtx()
    );

    expect(mcp).toEqual({ sessions: [summary], total: 1 });
    expect(sam).toEqual({ sessions: [summary], total: 1, projectId: PROJECT });
    expect(mocks.listSessions.mock.calls.map((call) => call.slice(1))).toEqual([
      [PROJECT, 'active', 3, 0, null],
      [PROJECT, 'active', 3, 0, 't1'],
    ]);
  });
});

describe('create mission: one shared quota, insert and orchestrator registration', () => {
  function missions() {
    return sqlite
      .prepare(
        'SELECT id, project_id, user_id, title, description, status, budget_config FROM missions ORDER BY created_at, id'
      )
      .all() as Record<string, unknown>[];
  }

  it('writes the same row shape from both surfaces and registers each mission', async () => {
    const mcp = mcpPayload(
      await handleCreateMission(
        1,
        { title: '  Ship it  ', description: 'Goal', budgetConfig: { maxTasks: 3 } },
        token(),
        env
      )
    ) as { id: string; status: string; title: string };
    const sam = (await createMission(
      { projectId: PROJECT, title: '  Plan  ', description: '  Scope  ' },
      samCtx()
    )) as { missionId: string; status: string; title: string };

    expect(mcp).toMatchObject({ status: 'planning', title: 'Ship it' });
    expect(sam).toMatchObject({ status: 'planning', title: 'Plan' });
    expect(missions()).toEqual(
      expect.arrayContaining([
        {
          id: mcp.id,
          project_id: PROJECT,
          user_id: OWNER,
          title: 'Ship it',
          description: 'Goal',
          status: 'planning',
          budget_config: '{"maxTasks":3}',
        },
        {
          id: sam.missionId,
          project_id: PROJECT,
          user_id: OWNER,
          title: 'Plan',
          description: 'Scope',
          status: 'planning',
          budget_config: null,
        },
      ])
    );
    expect(mocks.startOrchestration.mock.calls.map((call) => call.slice(1))).toEqual([
      [PROJECT, mcp.id],
      [PROJECT, sam.missionId],
    ]);
  });

  it('enforces one per-project quota and words the refusal per surface', async () => {
    env = { ...env, MISSION_MAX_PER_PROJECT: '1' } as Env;
    await createMission({ projectId: PROJECT, title: 'First' }, samCtx());

    const mcp = await handleCreateMission(1, { title: 'Second' }, token(), env);
    const sam = await createMission({ projectId: PROJECT, title: 'Third' }, samCtx());

    expect(mcpError(mcp)).toBe('Maximum missions per project (1) reached');
    expect(sam).toEqual({ error: 'Maximum missions per project (1) reached.' });
    expect(missions().map((row) => row.title)).toEqual(['First']);
    expect(mocks.startOrchestration).toHaveBeenCalledTimes(1);
  });

  it('keeps the mission when orchestrator registration fails', async () => {
    mocks.startOrchestration.mockRejectedValue(new Error('orchestrator unavailable'));

    const mcp = mcpPayload(await handleCreateMission(1, { title: 'Resilient' }, token(), env));

    expect(mcp).toMatchObject({ status: 'planning', title: 'Resilient' });
    expect(missions().map((row) => row.title)).toEqual(['Resilient']);
  });

  it('keeps /sam authorization: only the project owner can create a mission there', async () => {
    const sam = await createMission({ projectId: PROJECT, title: 'Nope' }, samCtx('other'));

    expect(sam).toEqual({ error: 'Project not found or not owned by you.' });
    expect(missions()).toEqual([]);
    expect(mocks.startOrchestration).not.toHaveBeenCalled();
  });
});
