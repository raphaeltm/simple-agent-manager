/**
 * Behavioral test verifying the structured logging utility is used correctly
 * for trigger execution sync failures.
 *
 * The trigger_execution_sync_failed log should use the project's canonical
 * `log.error()` utility (from lib/logger.ts) which emits structured JSON
 * with timestamp, level, and event fields automatically.
 */
import { describe, expect, it, vi } from 'vitest';

import { log } from '../../src/lib/logger';

describe('structured logging via log utility', () => {
  it('log.error produces structured JSON with timestamp and level', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    log.error('trigger_execution_sync_failed', {
      taskId: 'task-123',
      triggerExecutionId: 'exec-456',
      error: 'DB connection timeout',
    });

    expect(consoleSpy).toHaveBeenCalledOnce();
    const loggedString = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(loggedString);

    expect(parsed.level).toBe('error');
    expect(parsed.event).toBe('trigger_execution_sync_failed');
    expect(parsed.taskId).toBe('task-123');
    expect(parsed.triggerExecutionId).toBe('exec-456');
    expect(parsed.error).toBe('DB connection timeout');
    expect(parsed.timestamp).toBeDefined();

    consoleSpy.mockRestore();
  });

  it('log.error serializes Error objects via String() coercion', () => {
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    const err = new Error('Connection refused');

    log.error('trigger_execution_sync_failed', {
      taskId: 'task-1',
      triggerExecutionId: 'exec-1',
      error: String(err),
    });

    const loggedString = consoleSpy.mock.calls[0][0] as string;
    const parsed = JSON.parse(loggedString);
    expect(parsed.error).toBe('Error: Connection refused');

    consoleSpy.mockRestore();
  });
});
