import { beforeEach,describe, expect, it, vi } from 'vitest';

// Mock the observability service before importing logger
const mockPersistError = vi.fn().mockResolvedValue(undefined);
vi.mock('../../../src/services/observability', () => ({
  persistError: (...args: unknown[]) => mockPersistError(...args),
  persistErrorBatch: vi.fn(),
}));

import { createInstrumentedLogger } from '../../../src/lib/logger';

describe('Instrumented Logger', () => {
  const mockDb = {} as D1Database;
  const mockWaitUntil = vi.fn();

  async function waitForPersistCall(): Promise<void> {
    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    await mockWaitUntil.mock.calls[0][0];
  }

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('should write error-level entries to D1 when db is provided', async () => {
    const logger = createInstrumentedLogger(mockDb, mockWaitUntil);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('test_event', { detail: 'value' });

    // Should still log to console
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // Should persist to D1 via waitUntil
    await waitForPersistCall();
    expect(mockPersistError).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });

  it('should NOT write non-error-level entries to D1', () => {
    const logger = createInstrumentedLogger(mockDb, mockWaitUntil);
    const logSpy = vi.spyOn(console, 'log').mockImplementation(() => {});
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {});

    logger.info('info_event', { data: 1 });
    logger.warn('warn_event', { data: 2 });
    logger.debug('debug_event', { data: 3 });

    // waitUntil should NOT be called for non-error levels
    expect(mockWaitUntil).not.toHaveBeenCalled();
    expect(mockPersistError).not.toHaveBeenCalled();

    logSpy.mockRestore();
    warnSpy.mockRestore();
    debugSpy.mockRestore();
  });

  it('should skip D1 write when db is null', () => {
    const logger = createInstrumentedLogger(null, mockWaitUntil);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('test_event', { detail: 'value' });

    // Console log should still happen
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // No D1 write attempted
    expect(mockWaitUntil).not.toHaveBeenCalled();
    expect(mockPersistError).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('should skip D1 write when waitUntil is null', () => {
    const logger = createInstrumentedLogger(mockDb, null);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('test_event', { detail: 'value' });

    // Console log should still happen
    expect(errorSpy).toHaveBeenCalledTimes(1);

    // No D1 write
    expect(mockPersistError).not.toHaveBeenCalled();

    errorSpy.mockRestore();
  });

  it('should pass correct PersistErrorInput shape to persistError', async () => {
    const logger = createInstrumentedLogger(mockDb, mockWaitUntil);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('api_failure', {
      userId: 'user-1',
      path: '/api/test',
      authorization: 'Bearer secret-token',
    });

    await waitForPersistCall();
    expect(mockPersistError).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        source: 'api',
        level: 'error',
        message: 'api_failure',
        context: expect.objectContaining({ userId: 'user-1', path: '/api/test', authorization: '[REDACTED]' }),
      })
    );

    errorSpy.mockRestore();
  });

  it('should include event name as the message', async () => {
    const logger = createInstrumentedLogger(mockDb, mockWaitUntil);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('node_provision_failed', { nodeId: 'node-1', reason: 'timeout' });

    await waitForPersistCall();
    expect(mockPersistError).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        source: 'api',
        level: 'error',
        message: 'node_provision_failed',
        context: expect.objectContaining({ nodeId: 'node-1', reason: 'timeout' }),
      })
    );

    errorSpy.mockRestore();
  });

  it('should set context to null when no details provided', async () => {
    const logger = createInstrumentedLogger(mockDb, mockWaitUntil);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('bare_error');

    await waitForPersistCall();
    expect(mockPersistError).toHaveBeenCalledWith(
      mockDb,
      expect.objectContaining({
        context: null,
      })
    );

    errorSpy.mockRestore();
  });

  it('should preserve the original log interface (info, warn, debug, error)', () => {
    const logger = createInstrumentedLogger(null, null);

    expect(typeof logger.info).toBe('function');
    expect(typeof logger.warn).toBe('function');
    expect(typeof logger.debug).toBe('function');
    expect(typeof logger.error).toBe('function');
  });

  it('should pass a persistence promise to waitUntil', async () => {
    const logger = createInstrumentedLogger(mockDb, mockWaitUntil);
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    logger.error('test_event');

    expect(mockWaitUntil).toHaveBeenCalledTimes(1);
    expect(mockWaitUntil.mock.calls[0][0]).toBeInstanceOf(Promise);
    await mockWaitUntil.mock.calls[0][0];
    expect(mockPersistError).toHaveBeenCalledTimes(1);

    errorSpy.mockRestore();
  });
});
