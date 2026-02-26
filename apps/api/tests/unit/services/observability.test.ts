import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Env } from '../../../src/index';

// Use vi.hoisted() so mock functions are available when vi.mock factories run
const {
  mockInsertValues,
  mockInsert,
  mockSelectFrom,
  mockSelect,
  mockDelete,
} = vi.hoisted(() => {
  const mockInsertValues = vi.fn().mockResolvedValue(undefined);
  const mockInsert = vi.fn().mockReturnValue({ values: mockInsertValues });

  const mockSelectGet = vi.fn();
  const mockSelectAll = vi.fn();
  const mockSelectLimit = vi.fn().mockReturnValue({ all: mockSelectAll, get: mockSelectGet });
  const mockSelectOrderBy = vi.fn().mockReturnValue({ limit: mockSelectLimit, all: mockSelectAll });
  const mockSelectWhere = vi.fn().mockReturnValue({ orderBy: mockSelectOrderBy, limit: mockSelectLimit, all: mockSelectAll, get: mockSelectGet });
  const mockSelectFrom = vi.fn().mockReturnValue({ where: mockSelectWhere, orderBy: mockSelectOrderBy, limit: mockSelectLimit, all: mockSelectAll, get: mockSelectGet });
  const mockSelect = vi.fn().mockReturnValue({ from: mockSelectFrom });

  const mockDeleteWhere = vi.fn().mockResolvedValue(undefined);
  const mockDelete = vi.fn().mockReturnValue({ where: mockDeleteWhere });

  return { mockInsertValues, mockInsert, mockSelectFrom, mockSelect, mockDelete, mockSelectGet, mockSelectAll };
});

vi.mock('drizzle-orm/d1', () => ({
  drizzle: vi.fn().mockReturnValue({
    insert: mockInsert,
    select: mockSelect,
    delete: mockDelete,
  }),
}));

vi.mock('drizzle-orm', () => ({
  eq: vi.fn((_col: unknown, val: unknown) => ({ type: 'eq', val })),
  and: vi.fn((...args: unknown[]) => ({ type: 'and', args })),
  gte: vi.fn((_col: unknown, val: unknown) => ({ type: 'gte', val })),
  lte: vi.fn((_col: unknown, val: unknown) => ({ type: 'lte', val })),
  like: vi.fn((_col: unknown, val: unknown) => ({ type: 'like', val })),
  desc: vi.fn((col: unknown) => ({ type: 'desc', col })),
  count: vi.fn(() => 'count_agg'),
  sql: { raw: vi.fn() },
  or: vi.fn((...args: unknown[]) => ({ type: 'or', args })),
}));

vi.mock('../../../src/db/observability-schema', () => ({
  platformErrors: {
    id: 'id',
    source: 'source',
    level: 'level',
    message: 'message',
    stack: 'stack',
    context: 'context',
    userId: 'user_id',
    nodeId: 'node_id',
    workspaceId: 'workspace_id',
    ipAddress: 'ip_address',
    userAgent: 'user_agent',
    timestamp: 'timestamp',
    createdAt: 'created_at',
  },
}));

vi.mock('../../../src/db/schema', () => ({
  nodes: { id: 'id', status: 'status' },
  workspaces: { id: 'id', status: 'status' },
  tasks: { id: 'id', status: 'status' },
}));

// Import after mocks
import {
  persistError,
  persistErrorBatch,
  queryErrors,
  type PersistErrorInput,
} from '../../../src/services/observability';

describe('Observability Service', () => {
  const mockDb = {} as D1Database;

  beforeEach(() => {
    vi.clearAllMocks();
    mockInsertValues.mockResolvedValue(undefined);
  });

  describe('persistError()', () => {
    it('should insert a valid error into the database', async () => {
      const input: PersistErrorInput = {
        source: 'client',
        level: 'error',
        message: 'Something broke',
        stack: 'Error: Something broke\n  at foo.ts:1',
        userId: 'user-1',
      };

      await persistError(mockDb, input);

      expect(mockInsert).toHaveBeenCalledTimes(1);
      expect(mockInsertValues).toHaveBeenCalledWith(
        expect.objectContaining({
          source: 'client',
          level: 'error',
          message: 'Something broke',
          stack: 'Error: Something broke\n  at foo.ts:1',
          userId: 'user-1',
        })
      );
    });

    it('should generate a UUID for the id field', async () => {
      await persistError(mockDb, {
        source: 'api',
        message: 'Test error',
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.id).toBeDefined();
      expect(typeof values.id).toBe('string');
      expect(values.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
    });

    it('should default level to error for invalid levels', async () => {
      await persistError(mockDb, {
        source: 'client',
        level: 'critical' as any,
        message: 'Test',
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.level).toBe('error');
    });

    it('should default source to api for invalid sources', async () => {
      await persistError(mockDb, {
        source: 'unknown' as any,
        message: 'Test',
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.source).toBe('api');
    });

    it('should accept valid sources: client, vm-agent, api', async () => {
      for (const source of ['client', 'vm-agent', 'api'] as const) {
        vi.clearAllMocks();
        await persistError(mockDb, { source, message: `Test ${source}` });
        const values = mockInsertValues.mock.calls[0][0];
        expect(values.source).toBe(source);
      }
    });

    it('should accept valid levels: error, warn, info', async () => {
      for (const level of ['error', 'warn', 'info'] as const) {
        vi.clearAllMocks();
        await persistError(mockDb, { source: 'api', level, message: `Test ${level}` });
        const values = mockInsertValues.mock.calls[0][0];
        expect(values.level).toBe(level);
      }
    });

    it('should truncate message to 2048 chars', async () => {
      const longMessage = 'x'.repeat(3000);
      await persistError(mockDb, {
        source: 'client',
        message: longMessage,
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.message.length).toBeLessThanOrEqual(2048 + 3);
      expect(values.message.endsWith('...')).toBe(true);
    });

    it('should truncate stack to 4096 chars', async () => {
      const longStack = 'y'.repeat(5000);
      await persistError(mockDb, {
        source: 'api',
        message: 'Test',
        stack: longStack,
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.stack.length).toBeLessThanOrEqual(4096 + 3);
      expect(values.stack.endsWith('...')).toBe(true);
    });

    it('should truncate userAgent to 512 chars', async () => {
      const longUA = 'z'.repeat(600);
      await persistError(mockDb, {
        source: 'client',
        message: 'Test',
        userAgent: longUA,
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.userAgent.length).toBeLessThanOrEqual(512 + 3);
      expect(values.userAgent.endsWith('...')).toBe(true);
    });

    it('should not truncate short fields', async () => {
      await persistError(mockDb, {
        source: 'client',
        message: 'Short message',
        stack: 'Short stack',
        userAgent: 'Short UA',
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.message).toBe('Short message');
      expect(values.stack).toBe('Short stack');
      expect(values.userAgent).toBe('Short UA');
    });

    it('should serialize context to JSON string', async () => {
      await persistError(mockDb, {
        source: 'client',
        message: 'Test',
        context: { phase: 'transcription', retries: 3 },
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.context).toBe(JSON.stringify({ phase: 'transcription', retries: 3 }));
    });

    it('should set null for optional fields when not provided', async () => {
      await persistError(mockDb, {
        source: 'api',
        message: 'Test',
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.stack).toBeNull();
      expect(values.context).toBeNull();
      expect(values.userId).toBeNull();
      expect(values.nodeId).toBeNull();
      expect(values.workspaceId).toBeNull();
      expect(values.ipAddress).toBeNull();
      expect(values.userAgent).toBeNull();
    });

    it('should use provided timestamp', async () => {
      const fixedTimestamp = 1700000000000;
      await persistError(mockDb, {
        source: 'api',
        message: 'Test',
        timestamp: fixedTimestamp,
      });

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.timestamp).toBe(fixedTimestamp);
    });

    it('should default timestamp to current time when not provided', async () => {
      const before = Date.now();
      await persistError(mockDb, {
        source: 'api',
        message: 'Test',
      });
      const after = Date.now();

      const values = mockInsertValues.mock.calls[0][0];
      expect(values.timestamp).toBeGreaterThanOrEqual(before);
      expect(values.timestamp).toBeLessThanOrEqual(after);
    });

    it('should fail silently on D1 errors (logs warning)', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockInsertValues.mockRejectedValue(new Error('D1 write failed'));

      await persistError(mockDb, {
        source: 'client',
        message: 'Test',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        '[observability] Failed to persist error:',
        'D1 write failed'
      );

      warnSpy.mockRestore();
    });

    it('should fail silently for non-Error exceptions', async () => {
      const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
      mockInsertValues.mockRejectedValue('string error');

      await persistError(mockDb, {
        source: 'client',
        message: 'Test',
      });

      expect(warnSpy).toHaveBeenCalledWith(
        '[observability] Failed to persist error:',
        'string error'
      );

      warnSpy.mockRestore();
    });
  });

  describe('persistErrorBatch()', () => {
    it('should persist each error in the batch', async () => {
      const inputs: PersistErrorInput[] = [
        { source: 'client', message: 'Error 1' },
        { source: 'vm-agent', message: 'Error 2' },
        { source: 'api', message: 'Error 3' },
      ];

      await persistErrorBatch(mockDb, inputs);

      expect(mockInsert).toHaveBeenCalledTimes(3);
    });

    it('should enforce default batch size limit of 25', async () => {
      const inputs = Array.from({ length: 30 }, (_, i) => ({
        source: 'client' as const,
        message: `Error ${i}`,
      }));

      await persistErrorBatch(mockDb, inputs);

      expect(mockInsert).toHaveBeenCalledTimes(25);
    });

    it('should respect configurable batch size from env', async () => {
      const env = { OBSERVABILITY_ERROR_BATCH_SIZE: '5' } as unknown as Env;
      const inputs = Array.from({ length: 10 }, (_, i) => ({
        source: 'client' as const,
        message: `Error ${i}`,
      }));

      await persistErrorBatch(mockDb, inputs, env);

      expect(mockInsert).toHaveBeenCalledTimes(5);
    });

    it('should handle empty batch', async () => {
      await persistErrorBatch(mockDb, []);

      expect(mockInsert).not.toHaveBeenCalled();
    });
  });

  describe('queryErrors()', () => {
    it('should return empty results when no rows exist', async () => {
      // Mock count query
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      });
      // Mock data query
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await queryErrors(mockDb);

      expect(result.errors).toEqual([]);
      expect(result.hasMore).toBe(false);
      expect(result.cursor).toBeNull();
      expect(result.total).toBe(0);
    });

    it('should enforce max limit of 200', async () => {
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      });

      const mockLimit = vi.fn().mockResolvedValue([]);
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: mockLimit,
          }),
        }),
      });

      await queryErrors(mockDb, { limit: 500 });

      // limit should be capped to 200 + 1 (for hasMore check) = 201
      expect(mockLimit).toHaveBeenCalledWith(201);
    });

    it('should default limit to 50', async () => {
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      });

      const mockLimit = vi.fn().mockResolvedValue([]);
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: mockLimit,
          }),
        }),
      });

      await queryErrors(mockDb);

      expect(mockLimit).toHaveBeenCalledWith(51);
    });

    it('should detect hasMore when rows exceed limit', async () => {
      const now = Date.now();
      const rows = Array.from({ length: 4 }, (_, i) => ({
        id: `id-${i}`,
        source: 'client',
        level: 'error',
        message: `Error ${i}`,
        stack: null,
        context: null,
        userId: null,
        nodeId: null,
        workspaceId: null,
        ipAddress: null,
        userAgent: null,
        timestamp: now - i * 1000,
        createdAt: now - i * 1000,
      }));

      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 10 }]),
      });
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue(rows),
          }),
        }),
      });

      const result = await queryErrors(mockDb, { limit: 3 });

      expect(result.hasMore).toBe(true);
      expect(result.errors.length).toBe(3);
      expect(result.cursor).toBeDefined();
      expect(result.cursor).not.toBeNull();
      expect(result.total).toBe(10);
    });

    it('should format timestamps as ISO 8601 strings', async () => {
      const fixedTs = 1700000000000;
      const row = {
        id: 'id-1',
        source: 'api',
        level: 'error',
        message: 'Test',
        stack: null,
        context: null,
        userId: null,
        nodeId: null,
        workspaceId: null,
        ipAddress: null,
        userAgent: null,
        timestamp: fixedTs,
        createdAt: fixedTs,
      };

      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      });
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([row]),
          }),
        }),
      });

      const result = await queryErrors(mockDb);

      expect(result.errors[0].timestamp).toBe(new Date(fixedTs).toISOString());
    });

    it('should parse context JSON string into object', async () => {
      const row = {
        id: 'id-1',
        source: 'client',
        level: 'error',
        message: 'Test',
        stack: null,
        context: JSON.stringify({ phase: 'upload', retries: 2 }),
        userId: null,
        nodeId: null,
        workspaceId: null,
        ipAddress: null,
        userAgent: null,
        timestamp: Date.now(),
        createdAt: Date.now(),
      };

      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      });
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([row]),
          }),
        }),
      });

      const result = await queryErrors(mockDb);

      expect(result.errors[0].context).toEqual({ phase: 'upload', retries: 2 });
    });

    it('should return null context when context is null', async () => {
      const row = {
        id: 'id-1',
        source: 'api',
        level: 'warn',
        message: 'Test',
        stack: null,
        context: null,
        userId: null,
        nodeId: null,
        workspaceId: null,
        ipAddress: null,
        userAgent: null,
        timestamp: Date.now(),
        createdAt: Date.now(),
      };

      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 1 }]),
      });
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([row]),
          }),
        }),
      });

      const result = await queryErrors(mockDb);

      expect(result.errors[0].context).toBeNull();
    });

    it('should handle cursor-based pagination with base64 encoded timestamps', async () => {
      const cursor = btoa('1700000000000');
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 5 }]),
      });
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await queryErrors(mockDb, { cursor });

      expect(result.total).toBe(5);
    });

    it('should gracefully ignore invalid cursor', async () => {
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockResolvedValue([{ count: 0 }]),
      });
      mockSelectFrom.mockReturnValueOnce({
        where: vi.fn().mockReturnValue({
          orderBy: vi.fn().mockReturnValue({
            limit: vi.fn().mockResolvedValue([]),
          }),
        }),
      });

      const result = await queryErrors(mockDb, { cursor: '!!!invalid!!!' });
      expect(result.errors).toEqual([]);
    });
  });
});
