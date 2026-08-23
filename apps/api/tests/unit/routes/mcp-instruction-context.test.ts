import { beforeEach, describe, expect, it, vi } from 'vitest';

const mocks = vi.hoisted(() => ({
  selectRows: [] as unknown[][],
  drizzle: vi.fn(),
  projectData: {
    getSession: vi.fn(),
    getAllHighConfidenceKnowledge: vi.fn(),
    getKnowledgeEntityIndex: vi.fn(),
    getActivePolicies: vi.fn(),
    recordActivityEvent: vi.fn(),
  },
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: mocks.drizzle,
}));

vi.mock('../../../src/services/project-data', () => mocks.projectData);

import { handleGetInstructions, resolveInstructionContext } from '../../../src/routes/mcp/instruction-tools';
import { handleUpdateTaskStatus } from '../../../src/routes/mcp/task-tools';
import type { McpTokenData } from '../../../src/services/mcp-token';

const task = {
  id: 'task-1',
  projectId: 'project-1',
  title: 'Implement bootstrap',
  description: 'Unify bootstrap',
  status: 'in_progress',
  priority: 1,
  outputBranch: 'sam/bootstrap',
  taskMode: 'task',
};

const project = {
  id: 'project-1',
  name: 'SAM',
  repository: 'owner/repo',
  defaultBranch: 'main',
  repoProvider: 'github',
};

const baseToken: McpTokenData = {
  taskId: 'task-1',
  contextType: 'task',
  taskMode: 'task',
  projectId: 'project-1',
  userId: 'user-1',
  workspaceId: 'workspace-1',
  createdAt: new Date().toISOString(),
};

function makeEnv() {
  return {
    DATABASE: {},
    PROJECT_DATA: {
      idFromName: vi.fn().mockReturnValue('do-id'),
      get: vi.fn(),
    },
  } as never;
}

function makeMockDb() {
  return {
    select: vi.fn(() => ({
      from: vi.fn(() => ({
        where: vi.fn(() => ({
          limit: vi.fn(async () => mocks.selectRows.shift() ?? []),
        })),
      })),
    })),
  };
}

function parseInstructionPayload(response: Awaited<ReturnType<typeof handleGetInstructions>>) {
  expect(response.error).toBeUndefined();
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as Record<string, unknown>;
}

describe('MCP instruction context handlers', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mocks.selectRows = [];
    mocks.drizzle.mockReturnValue(makeMockDb());
    mocks.projectData.getSession.mockResolvedValue(null);
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue([
      {
        entityName: 'Architecture',
        entityType: 'context',
        content: 'Bootstrap policy stays in the Worker control plane.',
        confidence: 0.95,
      },
    ]);
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue([
      { name: 'Architecture', entityType: 'context', observationCount: 4 },
      { name: 'ContentStyle', entityType: 'preference', observationCount: 7 },
      { name: 'BusinessStrategy', entityType: 'context', observationCount: 2 },
    ]);
    mocks.projectData.getActivePolicies.mockResolvedValue([
      {
        id: 'policy-1',
        category: 'rule',
        title: 'Call get_instructions',
        content: 'Agents must load SAM context before starting work.',
        confidence: 0.95,
      },
    ]);
    mocks.projectData.recordActivityEvent.mockResolvedValue('event-1');
  });

  it('returns task-backed instructions with knowledge and policy directives', async () => {
    mocks.selectRows = [[task], [project]];

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);

    expect(payload.context).toMatchObject({ type: 'task', workspaceId: 'workspace-1' });
    expect(payload.task).toMatchObject({ id: 'task-1', title: 'Implement bootstrap' });
    expect(String(payload.knowledgeDirectives)).toContain('Worker control plane');
    expect(String(payload.policyDirectives)).toContain('Call get_instructions');
  });

  it('appends a complete entity index naming entities that were not injected', async () => {
    mocks.selectRows = [[task], [project]];

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);
    const directives = String(payload.knowledgeDirectives);

    // Only Architecture was injected in full; the other two must still be discoverable.
    expect(directives).toContain('Full knowledge index (3 entities)');
    expect(directives).toContain('ContentStyle (preference, 7)');
    expect(directives).toContain('BusinessStrategy (context, 2)');
    expect(directives).toContain('Architecture (context, 4)');
    // The agent must be told the block is partial and how to reach the rest.
    expect(directives).toContain('search_knowledge');
    expect(directives).toContain('get_relevant_knowledge');
    expect(directives).toContain('2 of these entities have no observations shown above');
  });

  it('passes the per-entity cap through to the knowledge query', async () => {
    mocks.selectRows = [[task], [project]];

    await handleGetInstructions('request-1', baseToken, makeEnv());

    // Default cap is 8 (KNOWLEDGE_DEFAULTS.autoRetrievePerEntityLimit). Without this
    // argument reaching the DO, one grab-bag entity reclaims every slot.
    expect(mocks.projectData.getAllHighConfidenceKnowledge).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      0.8,
      50,
      8
    );
  });

  it('still surfaces the index when ranked observation retrieval fails', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getAllHighConfidenceKnowledge.mockRejectedValue(new Error('DO unavailable'));

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);
    const directives = String(payload.knowledgeDirectives);

    // Degrading to "no knowledge at all" was the old silent failure. The index is
    // fetched independently, so the agent at least learns what exists.
    expect(directives).toContain('Full knowledge index');
    expect(directives).toContain('ContentStyle (preference, 7)');
    // Liveness control (rule 62): assert the response is otherwise intact, not crashed.
    expect(payload.task).toMatchObject({ id: 'task-1' });
  });

  it('omits the index section when the project has no entities', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue([]);
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue([]);

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);

    expect(payload.knowledgeDirectives).toBeUndefined();
    expect(payload.task).toMatchObject({ id: 'task-1' });
  });

  it('returns taskless conversation instructions resolved through chatSessionId', async () => {
    mocks.selectRows = [[project]];
    mocks.projectData.getSession.mockResolvedValue({
      id: 'chat-1',
      topic: 'Instant topic',
    });

    const response = await handleGetInstructions('request-1', {
      ...baseToken,
      taskId: '',
      contextType: 'conversation',
      taskMode: 'conversation',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-1',
    }, makeEnv());
    const payload = parseInstructionPayload(response);

    expect(payload.context).toMatchObject({
      type: 'conversation',
      chatSessionId: 'chat-1',
      workspaceId: 'workspace-1',
      agentSessionId: 'agent-1',
    });
    expect(payload.task).toBeUndefined();
    expect(payload.session).toMatchObject({ id: 'chat-1', topic: 'Instant topic' });
    expect(JSON.stringify(payload.instructions)).toContain('Do NOT call the SAM MCP `complete_task` tool');
    expect(String(payload.knowledgeDirectives)).toContain('Worker control plane');
    expect(String(payload.policyDirectives)).toContain('Call get_instructions');
  });

  it('resolves trial and direct-workspace contexts without a task row', async () => {
    const trial = await resolveInstructionContext({
      ...baseToken,
      taskId: '',
      contextType: 'trial',
      agentSessionId: 'trial-agent',
    }, makeEnv());
    const direct = await resolveInstructionContext({
      ...baseToken,
      taskId: '',
      contextType: 'direct-workspace',
      agentSessionId: 'direct-agent',
    }, makeEnv());

    expect(trial).toMatchObject({
      ok: true,
      context: { type: 'trial', workspaceId: 'workspace-1', agentSessionId: 'trial-agent' },
    });
    expect(direct).toMatchObject({
      ok: true,
      context: { type: 'direct-workspace', workspaceId: 'workspace-1', agentSessionId: 'direct-agent' },
    });
  });

  it('fails closed for malformed taskless conversation tokens', async () => {
    const result = await resolveInstructionContext({
      ...baseToken,
      taskId: '',
      contextType: 'conversation',
      taskMode: 'conversation',
      chatSessionId: undefined,
    }, makeEnv());

    expect(result).toEqual({ ok: false, message: 'Conversation context missing chatSessionId' });
  });

  it('records taskless update_task_status as session progress instead of Task not found', async () => {
    const response = await handleUpdateTaskStatus(
      'request-1',
      { message: 'Loaded project context' },
      {
        ...baseToken,
        taskId: '',
        contextType: 'conversation',
        taskMode: 'conversation',
        chatSessionId: 'chat-1',
        agentSessionId: 'agent-1',
      },
      makeEnv()
    );

    expect(response.error).toBeUndefined();
    expect(mocks.projectData.recordActivityEvent).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      'conversation.progress',
      'agent',
      'agent-1',
      'workspace-1',
      'chat-1',
      null,
      expect.objectContaining({ message: 'Loaded project context' })
    );
  });
});
