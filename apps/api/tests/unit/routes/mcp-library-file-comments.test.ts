import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { Env } from '../../../src/env';
import type { JsonRpcResponse, McpTokenData } from '../../../src/routes/mcp/_helpers';

const findFirstMock = vi.fn();

vi.mock('../../../src/services/project-data', () => ({
  listCommentThreads: vi.fn(),
  createFileCommentThread: vi.fn(),
}));

vi.mock('drizzle-orm/d1', () => ({
  drizzle: () => ({
    query: {
      projectFiles: { findFirst: findFirstMock },
    },
  }),
}));

import {
  handleCreateLibraryFileCommentThread,
  handleListLibraryFileCommentThreads,
} from '../../../src/routes/mcp/library-file-comment-tools';
import * as projectDataService from '../../../src/services/project-data';

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

function parseToolResponse(response: JsonRpcResponse): unknown {
  const result = response.result as { content: Array<{ text: string }> };
  return JSON.parse(result.content[0]?.text ?? '{}') as unknown;
}

describe('MCP library-file comment tools', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    findFirstMock.mockResolvedValue({ id: 'file-1' });
  });

  describe('handleListLibraryFileCommentThreads', () => {
    it('returns threads with cursor→afterSequence mapping', async () => {
      vi.mocked(projectDataService.listCommentThreads).mockResolvedValue({
        threads: [
          { id: 't-1', sequence: 5, status: 'open', body: 'hello', anchor: { kind: 'library_file', fileId: 'file-1', quote: null } } as never,
          { id: 't-2', sequence: 8, status: 'open', body: 'world', anchor: { kind: 'library_file', fileId: 'file-1', quote: null } } as never,
        ],
        hasMore: true,
      });

      const resp = await handleListLibraryFileCommentThreads(
        'req-1',
        { fileId: 'file-1', cursor: '3', limit: 10 },
        makeToken(),
        makeEnv()
      );

      expect(projectDataService.listCommentThreads).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({
          fileId: 'file-1',
          anchorKind: 'library_file',
          afterSequence: 3,
        })
      );

      const data = parseToolResponse(resp) as {
        threads: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(data.hasMore).toBe(true);
      expect(data.nextCursor).toBe('8');
      expect(data.threads).toHaveLength(2);
    });

    it('returns empty list without error', async () => {
      vi.mocked(projectDataService.listCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      const resp = await handleListLibraryFileCommentThreads(
        'req-2',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );

      const data = parseToolResponse(resp) as {
        threads: unknown[];
        hasMore: boolean;
        nextCursor: string | null;
      };
      expect(data.threads).toHaveLength(0);
      expect(data.hasMore).toBe(false);
      expect(data.nextCursor).toBeNull();
    });

    it('requires fileId', async () => {
      const resp = await handleListLibraryFileCommentThreads('req-3', {}, makeToken(), makeEnv());

      expect(resp.error).toBeDefined();
      expect((resp.error as { code: number }).code).toBe(-32602);
      expect((resp.error as { message: string }).message).toContain('fileId is required');
    });

    it('rejects caller-derived identity fields', async () => {
      const resp = await handleListLibraryFileCommentThreads(
        'req-4',
        { fileId: 'file-1', projectId: 'evil-project' },
        makeToken(),
        makeEnv()
      );

      expect(resp.error).toBeDefined();
      expect((resp.error as { code: number }).code).toBe(-32602);
      expect((resp.error as { message: string }).message).toContain('projectId is derived');
    });

    it('returns error when file does not exist', async () => {
      findFirstMock.mockResolvedValue(null);

      const resp = await handleListLibraryFileCommentThreads(
        'req-5',
        { fileId: 'nonexistent' },
        makeToken(),
        makeEnv()
      );

      expect(resp.error).toBeDefined();
      expect((resp.error as { message: string }).message).toContain('Library file not found');
    });

    it('handles null cursor by passing null afterSequence', async () => {
      vi.mocked(projectDataService.listCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      await handleListLibraryFileCommentThreads(
        'req-6',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );

      expect(projectDataService.listCommentThreads).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({ afterSequence: null })
      );
    });

    it('handles invalid cursor by passing null afterSequence', async () => {
      vi.mocked(projectDataService.listCommentThreads).mockResolvedValue({
        threads: [],
        hasMore: false,
      });

      await handleListLibraryFileCommentThreads(
        'req-7',
        { fileId: 'file-1', cursor: 'not-a-number' },
        makeToken(),
        makeEnv()
      );

      expect(projectDataService.listCommentThreads).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({ afterSequence: null })
      );
    });
  });

  describe('handleCreateLibraryFileCommentThread', () => {
    it('creates file comment thread with agent author', async () => {
      vi.mocked(projectDataService.createFileCommentThread).mockResolvedValue({
        thread: {
          id: 'ct-1',
          fileId: 'file-1',
          anchor: { kind: 'library_file', fileId: 'file-1', quote: 'code' },
          body: 'feedback',
          status: 'open',
          author: { kind: 'agent', id: 'agent-session-1', name: 'Agent (task-1)' },
          replies: [],
          sequence: 1,
          version: 1,
          createdAt: '2026-08-22T00:00:00.000Z',
          updatedAt: '2026-08-22T00:00:00.000Z',
        } as never,
        idempotent: false,
        changed: true,
      });

      const resp = await handleCreateLibraryFileCommentThread(
        'req-10',
        { fileId: 'file-1', body: 'feedback', quote: 'code' },
        makeToken(),
        makeEnv()
      );

      expect(projectDataService.createFileCommentThread).toHaveBeenCalledWith(
        expect.anything(),
        'project-1',
        expect.objectContaining({
          fileId: 'file-1',
          body: 'feedback',
          quote: 'code',
          actor: expect.objectContaining({ kind: 'agent' }),
        })
      );

      const data = parseToolResponse(resp) as { thread: { id: string } };
      expect(data.thread.id).toBe('ct-1');
    });

    it('rejects caller-derived identity fields on create', async () => {
      const resp = await handleCreateLibraryFileCommentThread(
        'req-11',
        { fileId: 'file-1', body: 'text', author: { kind: 'human', id: 'u-1', name: 'Hacker' } },
        makeToken(),
        makeEnv()
      );

      expect(resp.error).toBeDefined();
      expect((resp.error as { code: number }).code).toBe(-32602);
      expect((resp.error as { message: string }).message).toContain('author is derived');
    });

    it('requires fileId and body', async () => {
      const noFile = await handleCreateLibraryFileCommentThread(
        'req-12',
        { body: 'text' },
        makeToken(),
        makeEnv()
      );
      expect(noFile.error).toBeDefined();
      expect((noFile.error as { message: string }).message).toContain('fileId is required');

      const noBody = await handleCreateLibraryFileCommentThread(
        'req-13',
        { fileId: 'file-1' },
        makeToken(),
        makeEnv()
      );
      expect(noBody.error).toBeDefined();
      expect((noBody.error as { message: string }).message).toContain('body is required');
    });

    it('returns error when file does not exist', async () => {
      findFirstMock.mockResolvedValue(null);

      const resp = await handleCreateLibraryFileCommentThread(
        'req-14',
        { fileId: 'gone', body: 'text' },
        makeToken(),
        makeEnv()
      );

      expect(resp.error).toBeDefined();
      expect((resp.error as { message: string }).message).toContain('Library file not found');
    });

    it('handles service errors safely', async () => {
      vi.mocked(projectDataService.createFileCommentThread).mockRejectedValue(
        new Error('DO exploded')
      );

      const resp = await handleCreateLibraryFileCommentThread(
        'req-15',
        { fileId: 'file-1', body: 'text' },
        makeToken(),
        makeEnv()
      );

      expect(resp.error).toBeDefined();
      expect((resp.error as { message: string }).message).toBe('Comment tool failed');
      expect((resp.error as { message: string }).message).not.toContain('exploded');
    });
  });
});
