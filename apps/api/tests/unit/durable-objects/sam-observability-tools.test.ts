/**
 * Unit tests for SAM observability and context-awareness tools:
 * - list_sessions, get_session_messages, search_task_messages (task message search)
 * - search_code, get_file_content (codebase contextual search)
 * - helpers (resolveProjectWithOwnership, getUserGitHubToken, parseRepository)
 *
 * Tests cover:
 * - Parameter validation (missing/invalid required params)
 * - Ownership verification (reject unowned projectId)
 * - Successful execution with mocked services
 * - Registration in toolHandlers (executeTool dispatch)
 * - GitHub API error handling and no-credentials graceful fallback
 */
import { describe, expect, it, vi } from 'vitest';

import { executeTool, SAM_TOOLS } from '../../../src/durable-objects/sam-session/tools';
import { getFileContent } from '../../../src/durable-objects/sam-session/tools/get-file-content';
import { getSessionMessages } from '../../../src/durable-objects/sam-session/tools/get-session-messages';
import { parseRepository } from '../../../src/durable-objects/sam-session/tools/helpers';
import { listSessions } from '../../../src/durable-objects/sam-session/tools/list-sessions';
import { searchCode } from '../../../src/durable-objects/sam-session/tools/search-code';
import { searchTaskMessages } from '../../../src/durable-objects/sam-session/tools/search-task-messages';
import type { CollectedToolCall, ToolContext } from '../../../src/durable-objects/sam-session/types';

// Mock cloudflare:workers
vi.mock('cloudflare:workers', () => ({
  DurableObject: class {
    ctx: unknown;
    env: unknown;
    constructor(ctx: unknown, env: unknown) {
      this.ctx = ctx;
      this.env = env;
    }
  },
}));

vi.mock('../../../src/lib/secrets', () => ({
  getCredentialEncryptionKey: vi.fn().mockReturnValue('test-key'),
}));

vi.mock('../../../src/services/encryption', () => ({
  decrypt: vi.fn().mockResolvedValue('ghp_test_token_12345'),
}));

// Mock project-data service
const mockListSessions = vi.fn();
const mockGetSession = vi.fn();
const mockGetMessages = vi.fn();
const mockSearchMessages = vi.fn();

vi.mock('../../../src/services/project-data', () => ({
  listSessions: (...args: unknown[]) => mockListSessions(...args),
  getSession: (...args: unknown[]) => mockGetSession(...args),
  getMessages: (...args: unknown[]) => mockGetMessages(...args),
  searchMessages: (...args: unknown[]) => mockSearchMessages(...args),
}));

// ─── Helpers ──────────────────────────────────────────────────────────────────

/** Valid project row for ownership checks. */
const OWNED_PROJECT = {
  id: 'proj-1',
  repository: 'owner/repo',
  defaultBranch: 'main',
  installationId: null,
};

/** Credential row for GitHub token resolution. */
const GITHUB_CREDENTIAL = {
  encryptedToken: 'enc-token',
  iv: 'test-iv',
};

function mockD1(options: {
  firstResults?: (Record<string, unknown> | null)[];
  allResults?: Record<string, unknown>[];
} = {}) {
  const firstQueue = [...(options.firstResults ?? [null])];
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockImplementation(() => Promise.resolve(firstQueue.shift() ?? null)),
    raw: vi.fn().mockImplementation(() => {
      const row = firstQueue.shift() ?? null;
      return Promise.resolve(row ? [Object.values(row)] : []);
    }),
    all: vi.fn().mockResolvedValue({
      results: options.allResults ?? [],
      success: true,
    }),
    run: vi.fn().mockResolvedValue({ success: true, meta: { changes: 1 } }),
  };
  return {
    prepare: vi.fn().mockReturnValue(mockStatement),
    _statement: mockStatement,
  };
}

function buildCtx(overrides: {
  dbFirstResult?: Record<string, unknown> | null;
  dbFirstResults?: (Record<string, unknown> | null)[];
  dbAllResults?: Record<string, unknown>[];
  userId?: string;
} = {}): ToolContext {
  const firstResults = overrides.dbFirstResults
    ?? (overrides.dbFirstResult !== undefined ? [overrides.dbFirstResult] : [null]);
  const db = mockD1({
    firstResults,
    allResults: overrides.dbAllResults,
  });

  return {
    env: {
      DATABASE: db as unknown,
      PROJECT_DATA: {
        idFromName: vi.fn().mockReturnValue('do-id'),
        get: vi.fn().mockReturnValue({
          fetch: vi.fn().mockResolvedValue(new Response('ok')),
        }),
      },
    } as Record<string, unknown>,
    userId: overrides.userId ?? 'user-123',
  };
}

// ─── parseRepository ──────────────────────────────────────────────────────────

describe('parseRepository', () => {
  it('parses valid owner/repo format', () => {
    expect(parseRepository('owner/repo')).toEqual({ owner: 'owner', repo: 'repo' });
  });

  it('parses repos with dots and hyphens', () => {
    expect(parseRepository('my-org/my-repo.js')).toEqual({ owner: 'my-org', repo: 'my-repo.js' });
  });

  it('rejects empty string', () => {
    expect(parseRepository('')).toBeNull();
  });

  it('rejects string without slash', () => {
    expect(parseRepository('no-slash')).toBeNull();
  });

  it('rejects string with multiple slashes', () => {
    expect(parseRepository('a/b/c')).toBeNull();
  });
});

// ─── list_sessions ────────────────────────────────────────────────────────────

describe('list_sessions', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await listSessions({ projectId: '' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects unowned project', async () => {
    const ctx = buildCtx({ dbFirstResult: null });
    const result = await listSessions({ projectId: 'not-mine' }, ctx);
    expect(result).toEqual({ error: 'Project not found or not owned by you.' });
  });

  it('returns sessions for owned project', async () => {
    mockListSessions.mockResolvedValueOnce({ sessions: [{ id: 's1', topic: 'Test' }], total: 1 });
    const ctx = buildCtx({ dbFirstResult: OWNED_PROJECT });
    const result = await listSessions({ projectId: 'proj-1' }, ctx) as { sessions: unknown[]; total: number };
    expect(result.sessions).toHaveLength(1);
    expect(result.total).toBe(1);
  });

  it('dispatches via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-ls',
      name: 'list_sessions',
      input: { projectId: 'proj-1' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── get_session_messages ─────────────────────────────────────────────────────

describe('get_session_messages', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await getSessionMessages({ projectId: '', sessionId: 's1' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing sessionId', async () => {
    const ctx = buildCtx();
    const result = await getSessionMessages({ projectId: 'p1', sessionId: '' }, ctx);
    expect(result).toEqual({ error: 'sessionId is required.' });
  });

  it('rejects unowned project', async () => {
    const ctx = buildCtx({ dbFirstResult: null });
    const result = await getSessionMessages({ projectId: 'not-mine', sessionId: 's1' }, ctx);
    expect(result).toEqual({ error: 'Project not found or not owned by you.' });
  });

  it('returns messages for owned project session', async () => {
    mockGetSession.mockResolvedValueOnce({ id: 's1', topic: 'Test', taskId: 't1', status: 'running' });
    mockGetMessages.mockResolvedValueOnce({
      messages: [
        { id: 'm1', role: 'user', content: 'hello', createdAt: 1 },
        { id: 'm2', role: 'assistant', content: 'hi', createdAt: 2 },
      ],
      hasMore: false,
    });
    const ctx = buildCtx({ dbFirstResult: OWNED_PROJECT });
    const result = await getSessionMessages({ projectId: 'proj-1', sessionId: 's1' }, ctx) as {
      sessionId: string;
      messages: unknown[];
      messageCount: number;
    };
    expect(result.sessionId).toBe('s1');
    expect(result.messageCount).toBe(2);
    expect(result.messages).toHaveLength(2);
  });

  it('dispatches via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-gsm',
      name: 'get_session_messages',
      input: { projectId: 'proj-1', sessionId: 'sess-1' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── search_task_messages ─────────────────────────────────────────────────────

describe('search_task_messages', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await searchTaskMessages({ projectId: '', query: 'test' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing query', async () => {
    const ctx = buildCtx();
    const result = await searchTaskMessages({ projectId: 'p1', query: '' }, ctx);
    expect(result).toEqual({ error: 'query is required.' });
  });

  it('rejects short query', async () => {
    const ctx = buildCtx();
    const result = await searchTaskMessages({ projectId: 'p1', query: 'a' }, ctx);
    expect(result).toEqual({ error: 'query must be at least 2 characters.' });
  });

  it('rejects unowned project', async () => {
    const ctx = buildCtx({ dbFirstResult: null });
    const result = await searchTaskMessages({ projectId: 'not-mine', query: 'test query' }, ctx);
    expect(result).toEqual({ error: 'Project not found or not owned by you.' });
  });

  it('searches messages for owned project', async () => {
    mockSearchMessages.mockResolvedValueOnce([
      { id: 'm1', sessionId: 's1', sessionTopic: 'Topic', sessionTaskId: 't1', role: 'assistant', snippet: 'found it', createdAt: '2026-01-01' },
    ]);
    const ctx = buildCtx({ dbFirstResult: OWNED_PROJECT });
    const result = await searchTaskMessages({ projectId: 'proj-1', query: 'test query' }, ctx) as {
      results: unknown[];
      count: number;
      query: string;
    };
    expect(result.count).toBe(1);
    expect(result.query).toBe('test query');
    expect(result.results).toHaveLength(1);
  });

  it('resolves taskId to sessionId before searching', async () => {
    mockListSessions.mockResolvedValueOnce({ sessions: [{ id: 'resolved-session' }], total: 1 });
    mockSearchMessages.mockResolvedValueOnce([]);
    const ctx = buildCtx({ dbFirstResult: OWNED_PROJECT });
    await searchTaskMessages({ projectId: 'proj-1', query: 'test', taskId: 'task-123' }, ctx);
    expect(mockListSessions).toHaveBeenCalled();
    expect(mockSearchMessages).toHaveBeenCalledWith(
      expect.anything(), 'proj-1', 'test', 'resolved-session', null, expect.any(Number),
    );
  });

  it('dispatches via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-stm',
      name: 'search_task_messages',
      input: { projectId: 'proj-1', query: 'test query' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── search_code ──────────────────────────────────────────────────────────────

describe('search_code', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await searchCode({ projectId: '', query: 'function' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects missing query', async () => {
    const ctx = buildCtx();
    const result = await searchCode({ projectId: 'p1', query: '' }, ctx);
    expect(result).toEqual({ error: 'query is required.' });
  });

  it('rejects unowned project', async () => {
    const ctx = buildCtx({ dbFirstResult: null });
    const result = await searchCode({ projectId: 'not-mine', query: 'test' }, ctx);
    expect(result).toEqual({ error: 'Project not found or not owned by you.' });
  });

  it('returns no_credentials when GitHub token unavailable', async () => {
    // First call: ownership check passes. Second call: credential query returns null.
    const ctx = buildCtx({ dbFirstResults: [OWNED_PROJECT, null] });
    const result = await searchCode({ projectId: 'proj-1', query: 'test' }, ctx) as { status: string };
    expect(result.status).toBe('no_credentials');
  });

  it('dispatches via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-sc',
      name: 'search_code',
      input: { projectId: 'proj-1', query: 'function test' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── get_file_content ─────────────────────────────────────────────────────────

describe('get_file_content', () => {
  it('rejects missing projectId', async () => {
    const ctx = buildCtx();
    const result = await getFileContent({ projectId: '', path: 'src/index.ts' }, ctx);
    expect(result).toEqual({ error: 'projectId is required.' });
  });

  it('rejects unowned project', async () => {
    const ctx = buildCtx({ dbFirstResult: null });
    const result = await getFileContent({ projectId: 'not-mine', path: 'README.md' }, ctx);
    expect(result).toEqual({ error: 'Project not found or not owned by you.' });
  });

  it('rejects path traversal sequences', async () => {
    const ctx = buildCtx({ dbFirstResults: [OWNED_PROJECT, GITHUB_CREDENTIAL] });
    const result = await getFileContent({ projectId: 'proj-1', path: '../../etc/passwd' }, ctx);
    expect(result).toEqual({ error: 'Path traversal sequences are not allowed.' });
  });

  it('returns no_credentials when GitHub token unavailable', async () => {
    const ctx = buildCtx({ dbFirstResults: [OWNED_PROJECT, null] });
    const result = await getFileContent({ projectId: 'proj-1', path: 'README.md' }, ctx) as { status: string };
    expect(result.status).toBe('no_credentials');
  });

  it('dispatches via executeTool', async () => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: 'call-gfc',
      name: 'get_file_content',
      input: { projectId: 'proj-1', path: 'README.md' },
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    expect(r.error).toBeDefined();
    expect(r.error).not.toContain('Unknown tool');
  });
});

// ─── Tool registration ────────────────────────────────────────────────────────

describe('SAM_TOOLS registration', () => {
  const expectedTools = [
    'list_sessions',
    'get_session_messages',
    'search_task_messages',
    'search_code',
    'get_file_content',
  ];

  it.each(expectedTools)('includes %s in SAM_TOOLS', (toolName) => {
    const found = SAM_TOOLS.find((t) => t.name === toolName);
    expect(found).toBeDefined();
    expect(found?.input_schema).toBeDefined();
  });

  it.each(expectedTools)('dispatches %s via executeTool without Unknown tool error', async (toolName) => {
    const ctx = buildCtx();
    const toolCall: CollectedToolCall = {
      id: `call-${toolName}`,
      name: toolName,
      input: {},
    };
    const result = await executeTool(toolCall, ctx);
    const r = result as { error?: string };
    // Should get a validation error (missing params), NOT "Unknown tool"
    if (r.error) {
      expect(r.error).not.toContain('Unknown tool');
    }
  });
});
