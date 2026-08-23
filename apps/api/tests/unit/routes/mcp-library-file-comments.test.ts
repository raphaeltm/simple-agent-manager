import type { LibraryFileCommentThread } from '@simple-agent-manager/shared';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';

// ---------------------------------------------------------------------------
// Mocks — must be declared before importing the handlers
// ---------------------------------------------------------------------------

const findFirstMock = vi.fn();

vi.mock('../../../src/services/project-data', () => ({
  createFileCommentThread: vi.fn(),
  listFileCommentThreads: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    query: {
      projectFiles: { findFirst: findFirstMock },
    },
  }),
}));

vi.mock('../../../src/lib/logger', () => ({
  log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() },
}));

import {
  handleCreateLibraryFileCommentThread,
  handleListLibraryFileCommentThreads,
} from '../../../src/routes/mcp/library-file-comment-tools';
import * as projectDataService from '../../../src/services/project-data';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeToken(overrides: Partial<McpTokenData> = {}): McpTokenData {
  return {
    taskId: 'task-1',
    projectId: 'project-1',
    userId: 'user-1',
    workspaceId: 'workspace-1',
    chatSessionId: 'session-1',
    agentSessionId: 'agent-session-1',
    createdAt: '2026-08-22T00:00:00.000Z',
    ...overrides,
  };
}

function makeEnv(overrides = {}): Env {
  return {
    MCP_COMMENT_LIST_LIMIT: '5',
    MCP_COMMENT_LIST_MAX: '25',
    MCP_COMMENT_BODY_MAX_LENGTH: '4000',
    MCP_COMMENT_QUOTE_MAX_LENGTH: '1000',
    DATABASE: {} as D1Database,
    ...overrides,
  } as unknown as Env;
}

function makeFileThread(
  overrides: Partial<LibraryFileCommentThread> = {}
): LibraryFileCommentThread {
  return {
    id: 'thread-1',
    fileId: 'file-1',
    anchor: {
      kind: 'library_file',
      fileId: 'file-1',
      quote: 'some quoted code',
    },
    author: {
      kind: 'agent',
      id: 'agent-session-1',
      displayName: 'SAM agent',
    },
    body: 'Please address this feedback',
    status: 'open',
    createdAt: 1000,
    updatedAt: 1000,
    resolvedAt: null,
    replyCount: 0,
    lastReplyAt: null,
    replies: [],
    ...overrides,
  };
}

function parseToolResponse(response: JsonRpcResponse): unknown {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as unknown;
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MCP library-file comment tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // Default: file exists
    findFirstMock.mockResolvedValue({ id: 'file-1' });
  });

  // -----------------------------------------------------------------------
  // handleListLibraryFileCommentThreads
  // -----------------------------------------------------------------------

  describe('handleListLibraryFileCommentThreads', () => {
    it('lists file comment threads with cursor-to-afterSequence mapping', async () => {
      const threads = [
        { ...makeFileThread({ id: 't-1' }), sequence: 5 },
        { ...makeFileThread({ id: 't-2' }), sequence: 8 },
      ];
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads,
        hasMore: true,
      });

      const response = await handleListLibraryFileCommentThreads(
        'req-1',
        { fileId: 'file-1', cursor: '3', limit: 10 },
        makeToken(),
        makeEnv()
      );

      expect(response.error).toBeUndefined();
      expect(vi.mocked(projectDataService.listFileCommentThreads)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({
          fileId: 'file-1',
          afterSequence: 3,
        })
      );

      const data = parseToolResponse(response) as {
        threads: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(data.hasMore).toBe(true);
      // nextCursor is the string form of the last thread's sequence
      expect(data.nextCursor).toBe('8');
      expect(data.threads).toHaveLength(2);
    });

    it('returns empty list without error', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      const response = await handleListLibraryFileCommentThreads(
        'req-2',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );

      expect(response.error).toBeUndefined();
      expect(parseToolResponse(response)).toEqual({
        threads: [],
        hasMore: false,
        nextCursor: null,
      });
    });

    it('rejects caller-derived identity fields', async () => {
      const response = await handleListLibraryFileCommentThreads(
        'req-3',
        { fileId: 'file-1', projectId: 'evil-project' },
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('projectId is derived');
      expect(vi.mocked(projectDataService.listFileCommentThreads)).not.toHaveBeenCalled();
    });

    it('validates fileId is required', async () => {
      const response = await handleListLibraryFileCommentThreads(
        'req-4',
        {},
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('fileId is required');
      expect(vi.mocked(projectDataService.listFileCommentThreads)).not.toHaveBeenCalled();
    });

    it('returns error when file does not exist', async () => {
      findFirstMock.mockResolvedValue(null);

      const response = await handleListLibraryFileCommentThreads(
        'req-5',
        { fileId: 'nonexistent' },
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('Library file not found');
      expect(vi.mocked(projectDataService.listFileCommentThreads)).not.toHaveBeenCalled();
    });

    it('passes null afterSequence when cursor is absent', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      await handleListLibraryFileCommentThreads(
        'req-6',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );

      expect(vi.mocked(projectDataService.listFileCommentThreads)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({ afterSequence: null })
      );
    });

    it('passes null afterSequence when cursor is non-numeric', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      await handleListLibraryFileCommentThreads(
        'req-7',
        { fileId: 'file-1', cursor: 'not-a-number' },
        makeToken(),
        makeEnv()
      );

      expect(vi.mocked(projectDataService.listFileCommentThreads)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({ afterSequence: null })
      );
    });

    it('filters by status when provided', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      await handleListLibraryFileCommentThreads(
        'req-8',
        { fileId: 'file-1', status: 'resolved' },
        makeToken(),
        makeEnv()
      );

      expect(vi.mocked(projectDataService.listFileCommentThreads)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({ status: 'resolved' })
      );
    });

    it('passes null status for "all" filter', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      await handleListLibraryFileCommentThreads(
        'req-9',
        { fileId: 'file-1', status: 'all' },
        makeToken(),
        makeEnv()
      );

      expect(vi.mocked(projectDataService.listFileCommentThreads)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({ status: null })
      );
    });

    it('rejects invalid status values', async () => {
      const response = await handleListLibraryFileCommentThreads(
        'req-10',
        { fileId: 'file-1', status: 'invalid' },
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('status must be');
    });

    it('clamps limit to configured maximum', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      await handleListLibraryFileCommentThreads(
        'req-11',
        { fileId: 'file-1', limit: 999 },
        makeToken(),
        makeEnv({ MCP_COMMENT_LIST_MAX: '10' })
      );

      expect(vi.mocked(projectDataService.listFileCommentThreads)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({ limit: 10 })
      );
    });

    it('returns nextCursor as null when hasMore is false', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockResolvedValue({
        threads: [{ ...makeFileThread(), sequence: 3 }],
        hasMore: false,
      });

      const response = await handleListLibraryFileCommentThreads(
        'req-12',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );

      expect(response.error).toBeUndefined();
      const parsed = parseToolResponse(response) as { nextCursor: string | null };
      expect(parsed.nextCursor).toBeNull();
    });

    it('handles service errors safely without leaking stack traces', async () => {
      vi.mocked(projectDataService.listFileCommentThreads).mockRejectedValue(
        new Error('raw backend stack with token=secret')
      );

      const response = await handleListLibraryFileCommentThreads(
        'req-13',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );

      expect(response.error).toEqual({
        code: -32603,
        message: 'Comment tool failed',
      });
    });
  });

  // -----------------------------------------------------------------------
  // handleCreateLibraryFileCommentThread
  // -----------------------------------------------------------------------

  describe('handleCreateLibraryFileCommentThread', () => {
    it('creates file comment thread with agent author derived from token', async () => {
      const createdThread = makeFileThread({
        id: 'ct-1',
        author: { kind: 'agent', id: 'agent-session-1', displayName: 'SAM agent' },
      });
      vi.mocked(projectDataService.createFileCommentThread).mockResolvedValue({
        thread: createdThread,
        idempotent: false,
      });

      const response = await handleCreateLibraryFileCommentThread(
        'req-20',
        { fileId: 'file-1', body: 'feedback', quote: 'some code' },
        makeToken(),
        makeEnv()
      );

      expect(response.error).toBeUndefined();
      expect(vi.mocked(projectDataService.createFileCommentThread)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({
          fileId: 'file-1',
          body: 'feedback',
          quote: 'some code',
          clientMutationId: null,
          actor: { kind: 'agent', id: 'agent-session-1', displayName: 'SAM agent' },
        })
      );

      const data = parseToolResponse(response) as { thread: { id: string } };
      expect(data.thread.id).toBe('ct-1');
    });

    it('rejects caller-derived identity fields', async () => {
      const response = await handleCreateLibraryFileCommentThread(
        'req-21',
        { fileId: 'file-1', body: 'feedback', projectId: 'project-2' },
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('projectId is derived');
      expect(vi.mocked(projectDataService.createFileCommentThread)).not.toHaveBeenCalled();
    });

    it('rejects all caller-derived fields individually', async () => {
      const derivedFields = [
        'userId',
        'author',
        'authorId',
        'authorKind',
        'authorDisplayName',
        'provenance',
      ];

      for (const field of derivedFields) {
        vi.clearAllMocks();
        findFirstMock.mockResolvedValue({ id: 'file-1' });

        const response = await handleCreateLibraryFileCommentThread(
          'req-derived',
          { fileId: 'file-1', body: 'feedback', [field]: 'spoofed' },
          makeToken(),
          makeEnv()
        );

        expect(response.error?.code).toBe(-32602);
        expect(response.error?.message).toContain(`${field} is derived`);
      }
    });

    it('validates fileId is required', async () => {
      const response = await handleCreateLibraryFileCommentThread(
        'req-22',
        { body: 'feedback' },
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('fileId is required');
    });

    it('validates body is required', async () => {
      const response = await handleCreateLibraryFileCommentThread(
        'req-23',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('body is required');
    });

    it('returns error when file does not exist', async () => {
      findFirstMock.mockResolvedValue(null);

      const response = await handleCreateLibraryFileCommentThread(
        'req-24',
        { fileId: 'nonexistent-file', body: 'feedback' },
        makeToken(),
        makeEnv()
      );

      expect(response.error?.code).toBe(-32602);
      expect(response.error?.message).toContain('Library file not found');
      expect(vi.mocked(projectDataService.createFileCommentThread)).not.toHaveBeenCalled();
    });

    it('handles service errors safely without leaking stack traces', async () => {
      vi.mocked(projectDataService.createFileCommentThread).mockRejectedValue(
        new Error('DO exploded with credentials=leak')
      );

      const response = await handleCreateLibraryFileCommentThread(
        'req-25',
        { fileId: 'file-1', body: 'feedback' },
        makeToken(),
        makeEnv()
      );

      expect(response.error).toEqual({
        code: -32603,
        message: 'Comment tool failed',
      });
      // Ensure no raw error message leaked
      expect(response.error?.message).not.toContain('exploded');
      expect(response.error?.message).not.toContain('credentials');
    });

    it('passes quote as null when not provided', async () => {
      vi.mocked(projectDataService.createFileCommentThread).mockResolvedValue({
        thread: makeFileThread(),
        idempotent: false,
      });

      await handleCreateLibraryFileCommentThread(
        'req-26',
        { fileId: 'file-1', body: 'feedback' },
        makeToken(),
        makeEnv()
      );

      expect(vi.mocked(projectDataService.createFileCommentThread)).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({
          quote: null,
        })
      );
    });

    it('uses projectId from token, not from params', async () => {
      vi.mocked(projectDataService.createFileCommentThread).mockResolvedValue({
        thread: makeFileThread(),
        idempotent: false,
      });

      await handleCreateLibraryFileCommentThread(
        'req-27',
        { fileId: 'file-1', body: 'feedback' },
        makeToken({ projectId: 'my-project' }),
        makeEnv()
      );

      expect(vi.mocked(projectDataService.createFileCommentThread)).toHaveBeenCalledWith(
        expect.anything(),
        'my-project',
        expect.anything()
      );
    });
  });
});
