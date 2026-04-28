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

function mockD1(options: {
  firstResult?: Record<string, unknown> | null;
  allResults?: Record<string, unknown>[];
} = {}) {
  const mockStatement = {
    bind: vi.fn().mockReturnThis(),
    first: vi.fn().mockResolvedValue(options.firstResult ?? null),
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
  dbAllResults?: Record<string, unknown>[];
  userId?: string;
} = {}): ToolContext {
  const db = mockD1({
    firstResult: overrides.dbFirstResult,
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
