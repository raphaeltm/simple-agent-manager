import { describe, expect, it } from 'vitest';
import {
  canTransitionTaskStatus,
  getAllowedTaskTransitions,
  isExecutableTaskStatus,
  isTaskStatus,
} from '../../../src/services/task-status';

describe('task-status service', () => {
  it('validates known status names', () => {
    expect(isTaskStatus('draft')).toBe(true);
    expect(isTaskStatus('in_progress')).toBe(true);
    expect(isTaskStatus('unknown')).toBe(false);
  });

  it('exposes allowed transitions from each status', () => {
    expect(getAllowedTaskTransitions('draft')).toEqual(['ready', 'cancelled']);
    expect(getAllowedTaskTransitions('ready')).toEqual(['queued', 'delegated', 'cancelled']);
    expect(getAllowedTaskTransitions('completed')).toEqual([]);
  });

  it('accepts valid transitions and rejects invalid ones', () => {
    expect(canTransitionTaskStatus('draft', 'ready')).toBe(true);
    expect(canTransitionTaskStatus('ready', 'draft')).toBe(false);
    expect(canTransitionTaskStatus('in_progress', 'completed')).toBe(true);
    expect(canTransitionTaskStatus('completed', 'ready')).toBe(false);
  });

  it('identifies executable statuses for dependency gating', () => {
    expect(isExecutableTaskStatus('queued')).toBe(true);
    expect(isExecutableTaskStatus('delegated')).toBe(true);
    expect(isExecutableTaskStatus('in_progress')).toBe(true);
    expect(isExecutableTaskStatus('ready')).toBe(false);
  });
});
