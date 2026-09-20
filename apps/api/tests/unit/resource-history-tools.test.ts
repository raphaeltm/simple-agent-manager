import { beforeEach,describe, expect, it, vi } from 'vitest';

import type { McpTokenData } from '../../src/services/mcp-token';

const mockGetWorkspaceResourceHistory = vi.fn();
const mockResolveProjectWithOwnership = vi.fn();

vi.mock('../../src/services/workspace-resource-history', () => ({
  getWorkspaceResourceHistory: (...args: unknown[]) => mockGetWorkspaceResourceHistory(...args),
}));

vi.mock('../../src/durable-objects/sam-session/tools/helpers', async (importOriginal) => {
  const original =
    await importOriginal<typeof import('../../src/durable-objects/sam-session/tools/helpers')>();
  return {
    ...original,
    resolveProjectWithOwnership: (...args: unknown[]) => mockResolveProjectWithOwnership(...args),
  };
});

const ownedProject = { id: 'proj-1', repository: 'owner/repo', defaultBranch: 'main' };

function mockD1(project: Record<string, unknown> | null = ownedProject) {
  const statement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(project),
    all: vi.fn().mockResolvedValue({ results: [], success: true }),
    raw: vi.fn().mockResolvedValue([]),
    run: vi.fn().mockResolvedValue({ success: true }),
  };
  return {
    prepare: vi.fn().mockReturnValue(statement),
  };
}

describe('resource history MCP tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockGetWorkspaceResourceHistory.mockResolvedValue({
      summary: { id: 'summary-1', sampleCount: 12 },
      chunks: [{ id: 'wrchunk:1', sampleCount: 12 }],
    });
  });

  it('defaults to the MCP caller session, task, and workspace when no explicit scope is supplied', async () => {
    const { handleGetResourceHistory } = await import('../../src/routes/mcp/session-tools');
    const tokenData: McpTokenData = {
      projectId: 'proj-1',
      taskId: 'task-1',
      userId: 'user-1',
      workspaceId: 'ws-1',
      chatSessionId: 'sess-1',
      agentSessionId: 'agent-session-1',
      createdAt: new Date().toISOString(),
    };

    const response = await handleGetResourceHistory(1, {}, tokenData, {} as never);

    expect(mockGetWorkspaceResourceHistory).toHaveBeenCalledWith(expect.anything(), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      taskId: 'task-1',
      workspaceId: 'ws-1',
      detailChunkId: null,
    });
    const text = (response.result as { content: Array<{ text: string }> }).content[0]!.text;
    expect(JSON.parse(text)).toMatchObject({
      scope: { projectId: 'proj-1', sessionId: 'sess-1', taskId: 'task-1', workspaceId: 'ws-1' },
      summary: { id: 'summary-1' },
    });
  });

  it('uses explicit scope without silently intersecting the current workspace', async () => {
    const { handleGetResourceHistory } = await import('../../src/routes/mcp/session-tools');
    const tokenData: McpTokenData = {
      projectId: 'proj-1',
      taskId: 'task-current',
      userId: 'user-1',
      workspaceId: 'ws-current',
      chatSessionId: 'sess-current',
      createdAt: new Date().toISOString(),
    };

    await handleGetResourceHistory(
      1,
      { sessionId: 'sess-other', chunkId: 'wrchunk:other' },
      tokenData,
      {} as never
    );

    expect(mockGetWorkspaceResourceHistory).toHaveBeenCalledWith(expect.anything(), {
      projectId: 'proj-1',
      sessionId: 'sess-other',
      taskId: null,
      workspaceId: null,
      detailChunkId: 'wrchunk:other',
    });
  });

  it('rejects unscoped requests when the token has no workspace context', async () => {
    const { handleGetResourceHistory } = await import('../../src/routes/mcp/session-tools');
    const tokenData: McpTokenData = {
      projectId: 'proj-1',
      taskId: '',
      userId: 'user-1',
      workspaceId: '',
      createdAt: new Date().toISOString(),
    };

    const response = await handleGetResourceHistory(1, {}, tokenData, {} as never);

    expect(response.error?.code).toBe(-32602);
    expect(mockGetWorkspaceResourceHistory).not.toHaveBeenCalled();
  });
});

describe('SAM native get_resource_history tool', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    mockResolveProjectWithOwnership.mockResolvedValue(ownedProject);
    mockGetWorkspaceResourceHistory.mockResolvedValue({
      summary: { id: 'summary-1', sampleCount: 7 },
      chunks: [{ id: 'wrchunk:1', sampleCount: 7 }],
    });
  });

  it('is registered and dispatched through the SAM native tool registry', async () => {
    const { executeTool, SAM_TOOLS } = await import('../../src/durable-objects/sam-session/tools');

    expect(SAM_TOOLS.map((tool) => tool.name)).toContain('get_resource_history');

    const result = await executeTool(
      {
        id: 'call-resource-history',
        name: 'get_resource_history',
        input: { projectId: 'proj-1', sessionId: 'sess-1', chunkId: 'wrchunk:1' },
      },
      { env: { DATABASE: mockD1() }, userId: 'user-1' }
    );

    expect(mockGetWorkspaceResourceHistory).toHaveBeenCalledWith(expect.anything(), {
      projectId: 'proj-1',
      sessionId: 'sess-1',
      taskId: null,
      workspaceId: null,
      detailChunkId: 'wrchunk:1',
    });
    expect(result).toMatchObject({
      scope: { projectId: 'proj-1', sessionId: 'sess-1', taskId: null, workspaceId: null },
      summary: { id: 'summary-1' },
    });
  });

  it('enforces project ownership before reading resource history', async () => {
    const { getResourceHistory } =
      await import('../../src/durable-objects/sam-session/tools/get-resource-history');

    mockResolveProjectWithOwnership.mockResolvedValueOnce(null);

    const result = await getResourceHistory(
      { projectId: 'proj-2', sessionId: 'sess-1' },
      { env: { DATABASE: mockD1(null) }, userId: 'user-1' }
    );

    expect(result).toEqual({ error: 'Project not found or not owned by you.' });
    expect(mockGetWorkspaceResourceHistory).not.toHaveBeenCalled();
  });
});
