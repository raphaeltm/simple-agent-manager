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
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue({
      entries: [
        { name: 'Architecture', entityType: 'context', observationCount: 4 },
        { name: 'ContentStyle', entityType: 'preference', observationCount: 7 },
        { name: 'BusinessStrategy', entityType: 'context', observationCount: 2 },
      ],
      totalEntities: 3,
    });
    mocks.projectData.getActivePolicies.mockResolvedValue([
      {
        id: 'policy-1',
        category: 'rule',
        title: 'Call get_instructions',
        content: 'Agents must load SAM context before starting work.',
        confidence: 0.95,
        scope: 'always',
        expiresAt: null,
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
    // A standing policy carries no lifecycle annotation — this is the control that
    // keeps the annotation from leaking onto the ~81 permanent policies.
    expect(String(payload.policyDirectives)).not.toMatch(/expires/i);
  });

  it('annotates an expiring policy so an agent does not read it as a permanent gate', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getActivePolicies.mockResolvedValue([
      {
        id: 'policy-2',
        category: 'constraint',
        title: 'Use profile X for the reliability wave',
        content: 'Applies to the 2026-08-21 workstream only.',
        confidence: 0.9,
        scope: 'task',
        expiresAt: Date.UTC(2026, 8, 15, 12, 0, 0),
      },
    ]);

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);

    const directives = String(payload.policyDirectives);
    expect(directives).toContain('(task-scoped, expires 2026-09-15)');
    // The annotation must sit on the title line with the policy it describes, AND coexist
    // with the policy id that update_policy/remove_policy need in order to address the row
    // (added by the get_instructions payload-reduction change this branch rebased onto).
    expect(directives).toContain(
      '- **Use profile X for the reliability wave** (task-scoped, expires 2026-09-15) (id: policy-2): Applies to the 2026-08-21 workstream only.'
    );
  });

  it('annotates an always-scoped policy that has an expiry without calling it task-scoped', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getActivePolicies.mockResolvedValue([
      {
        id: 'policy-3',
        category: 'rule',
        title: 'Retiring rule',
        content: 'Content.',
        confidence: 0.9,
        scope: 'always',
        expiresAt: Date.UTC(2026, 11, 1, 0, 0, 0),
      },
    ]);

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const directives = String(parseInstructionPayload(response).policyDirectives);

    expect(directives).toContain('(expires 2026-12-01)');
    expect(directives).not.toContain('task-scoped');
  });

  it('tells conversation agents to give one-shot policies an expiry when capturing them', async () => {
    // Without this instruction the whole feature is inert: agents would keep saving
    // dated workflow constraints as permanent policies, which is the measured problem.
    mocks.selectRows = [[project]];
    mocks.projectData.getSession.mockResolvedValue({ id: 'chat-1', topic: 'Instant topic' });

    const response = await handleGetInstructions('request-1', {
      ...baseToken,
      taskId: '',
      contextType: 'conversation',
      taskMode: 'conversation',
      chatSessionId: 'chat-1',
      agentSessionId: 'agent-1',
    }, makeEnv());
    const payload = parseInstructionPayload(response);
    const instructions = (payload.instructions as string[]).join('\n');

    expect(instructions).toMatch(/scope: "task"/);
    expect(instructions).toMatch(/expiresAt/);
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
    expect(directives).toContain('2 of the entities listed here have no observations shown above');
  });

  it('never tells the agent the index is complete when it is truncated', async () => {
    mocks.selectRows = [[task], [project]];
    // 3 entities listed, 40 actually exist — the index itself is truncated.
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue({
      entries: [
        { name: 'Architecture', entityType: 'context', observationCount: 4 },
        { name: 'ContentStyle', entityType: 'preference', observationCount: 7 },
        { name: 'BusinessStrategy', entityType: 'context', observationCount: 2 },
      ],
      totalEntities: 40,
    });

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);
    const directives = String(payload.knowledgeDirectives);
    const instructions = (payload.instructions as string[]).join('\n');

    // The heading must state N of M rather than claiming completeness...
    expect(directives).toContain('3 of 40 entities');
    expect(directives).not.toContain('Full knowledge index');
    expect(directives).toContain('A further 37 entities are not listed');

    // ...and the instructions must not re-assert completeness one layer up. This is the
    // rule-65 bug reintroduced in prose: the index block was honest while the sentence
    // pointing at it said "Full knowledge index ... lists every entity".
    expect(instructions).not.toContain('Full knowledge index');
    expect(instructions).not.toMatch(/index[^.]*lists every entity/i);
    // Liveness control (rule 62) — an absence assertion needs a positive one beside it.
    expect(instructions).toContain('knowledge-index section');
    expect(payload.task).toMatchObject({ id: 'task-1' });
  });

  it('does not claim the graph is empty when entities exist below the confidence bar', async () => {
    mocks.selectRows = [[task], [project]];
    // Nothing clears the confidence bar, but the project plainly HAS knowledge — it is
    // reachable by search. Gating the instructions on the ranked set alone would hand this
    // project the "empty graph, start bootstrapping" prompt while its index lists entities.
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue([]);

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);
    const instructions = (payload.instructions as string[]).join('\n');

    expect(instructions).toContain('contains stored knowledge from previous sessions');
    expect(instructions).not.toContain('No knowledge has been stored');
    // Positive control (rule 62): the index really did survive into the payload.
    expect(String(payload.knowledgeDirectives)).toContain('ContentStyle (preference, 7)');
  });

  it('passes the entity index limit through to the index query', async () => {
    mocks.selectRows = [[task], [project]];

    await handleGetInstructions('request-1', baseToken, makeEnv());

    // Default is 200 (KNOWLEDGE_DEFAULTS.entityIndexLimit). The per-entity cap has an
    // equivalent assertion below; without this one the index limit could stop being
    // threaded and nothing would notice.
    expect(mocks.projectData.getKnowledgeEntityIndex).toHaveBeenCalledWith(
      expect.anything(),
      'project-1',
      200
    );
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

  it('keeps the ranked directives when only the entity index fails', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getKnowledgeEntityIndex.mockRejectedValue(new Error('DO unavailable'));

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const directives = String(parseInstructionPayload(response).knowledgeDirectives);

    // Mirror of the ranked-retrieval failure case: each read is isolated, so losing one
    // must not take the other down with it.
    expect(directives).toContain('Worker control plane');
    expect(directives).not.toContain('knowledge index');
  });

  it('degrades to the bootstrap prompt when both knowledge reads fail', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getAllHighConfidenceKnowledge.mockRejectedValue(new Error('DO down'));
    mocks.projectData.getKnowledgeEntityIndex.mockRejectedValue(new Error('DO down'));

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const payload = parseInstructionPayload(response);

    // Both isolated handlers firing at once must not combine into a broken payload.
    expect(payload.knowledgeDirectives).toBeUndefined();
    expect(JSON.stringify(payload.instructions)).toContain('no stored knowledge yet');
    // Liveness control — the request still succeeded rather than erroring out.
    expect(payload.task).toMatchObject({ id: 'task-1' });
  });

  it('labels the index as partial when more entities exist than are listed', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue({
      entries: [{ name: 'Architecture', entityType: 'context', observationCount: 4 }],
      totalEntities: 12,
    });

    const response = await handleGetInstructions('request-1', baseToken, makeEnv());
    const directives = String(parseInstructionPayload(response).knowledgeDirectives);

    // Must NOT claim completeness it cannot back.
    expect(directives).not.toContain('Full knowledge index');
    expect(directives).toContain('1 of 12 entities');
    expect(directives).toContain('A further 11 entities are not listed');
  });

  it('omits the index section when the project has no entities', async () => {
    mocks.selectRows = [[task], [project]];
    mocks.projectData.getAllHighConfidenceKnowledge.mockResolvedValue([]);
    mocks.projectData.getKnowledgeEntityIndex.mockResolvedValue({ entries: [], totalEntities: 0 });

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
