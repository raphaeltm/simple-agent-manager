import { describe, expect, it } from 'vitest';

import { isTaskStatus, TASK_STATUSES } from '../src/types';

describe('isTaskStatus', () => {
  it.each(TASK_STATUSES)('returns true for valid status: %s', (status) => {
    expect(isTaskStatus(status)).toBe(true);
  });

  it('returns false for invalid string', () => {
    expect(isTaskStatus('invalid')).toBe(false);
    expect(isTaskStatus('COMPLETED')).toBe(false);
    expect(isTaskStatus('running')).toBe(false);
  });

  it('returns false for non-string values', () => {
    expect(isTaskStatus(42)).toBe(false);
    expect(isTaskStatus(null)).toBe(false);
    expect(isTaskStatus(undefined)).toBe(false);
    expect(isTaskStatus({})).toBe(false);
    expect(isTaskStatus(true)).toBe(false);
  });

  it('returns false for empty string', () => {
    expect(isTaskStatus('')).toBe(false);
  });
});

describe('TASK_STATUSES', () => {
  it('contains all expected statuses', () => {
    expect(TASK_STATUSES).toEqual([
      'draft',
      'ready',
      'queued',
      'delegated',
      'in_progress',
      'completed',
      'failed',
      'cancelled',
    ]);
  });

  it('has 8 statuses', () => {
    expect(TASK_STATUSES).toHaveLength(8);
  });
});
