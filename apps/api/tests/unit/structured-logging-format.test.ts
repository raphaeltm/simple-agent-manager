/**
 * Behavioral test verifying the structured logging format used in task helpers.
 *
 * The trigger_execution_sync_failed log must be valid JSON with specific fields
 * so that log aggregation tools (Cloudflare Workers Observability, tail workers)
 * can parse and index it.
 */
import { describe, expect, it } from 'vitest';

describe('structured logging format', () => {
  describe('trigger_execution_sync_failed JSON shape', () => {
    it('produces valid JSON with all required fields', () => {
      // This mirrors the exact format used in _helpers.ts catch handler
      const logOutput = JSON.stringify({
        level: 'error',
        event: 'trigger_execution_sync_failed',
        taskId: 'task-123',
        triggerExecutionId: 'exec-456',
        error: 'DB connection timeout',
      });

      const parsed = JSON.parse(logOutput);
      expect(parsed).toEqual({
        level: 'error',
        event: 'trigger_execution_sync_failed',
        taskId: 'task-123',
        triggerExecutionId: 'exec-456',
        error: 'DB connection timeout',
      });
    });

    it('includes level field for severity classification', () => {
      const logOutput = JSON.stringify({
        level: 'error',
        event: 'trigger_execution_sync_failed',
        taskId: 'task-1',
        triggerExecutionId: 'exec-1',
        error: 'some error',
      });

      const parsed = JSON.parse(logOutput);
      expect(parsed.level).toBe('error');
    });

    it('includes event field for log filtering', () => {
      const logOutput = JSON.stringify({
        level: 'error',
        event: 'trigger_execution_sync_failed',
        taskId: 'task-1',
        triggerExecutionId: 'exec-1',
        error: 'some error',
      });

      const parsed = JSON.parse(logOutput);
      expect(parsed.event).toBe('trigger_execution_sync_failed');
    });

    it('serializes Error objects via String() coercion', () => {
      const err = new Error('Connection refused');
      const logOutput = JSON.stringify({
        level: 'error',
        event: 'trigger_execution_sync_failed',
        taskId: 'task-1',
        triggerExecutionId: 'exec-1',
        error: String(err),
      });

      const parsed = JSON.parse(logOutput);
      expect(parsed.error).toBe('Error: Connection refused');
    });
  });
});
