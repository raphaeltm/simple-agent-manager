import { describe, expect, it } from 'vitest';

import {
  isMissionStateEntryType,
  isMissionStatus,
  isSchedulerState,
  MISSION_STATE_ENTRY_TYPES,
  MISSION_STATUSES,
  SCHEDULER_STATES,
} from '@simple-agent-manager/shared';

describe('Mission type guards', () => {
  describe('isMissionStatus', () => {
    it('returns true for all valid mission statuses', () => {
      for (const status of MISSION_STATUSES) {
        expect(isMissionStatus(status)).toBe(true);
      }
    });

    it('returns false for invalid values', () => {
      expect(isMissionStatus('invalid')).toBe(false);
      expect(isMissionStatus('')).toBe(false);
      expect(isMissionStatus(null)).toBe(false);
      expect(isMissionStatus(undefined)).toBe(false);
    });
  });

  describe('isSchedulerState', () => {
    it('returns true for all valid scheduler states', () => {
      for (const state of SCHEDULER_STATES) {
        expect(isSchedulerState(state)).toBe(true);
      }
    });

    it('returns false for invalid values', () => {
      expect(isSchedulerState('invalid')).toBe(false);
    });

    it('covers all 11 scheduler states', () => {
      expect(SCHEDULER_STATES).toHaveLength(11);
      expect(SCHEDULER_STATES).toContain('schedulable');
      expect(SCHEDULER_STATES).toContain('blocked_dependency');
      expect(SCHEDULER_STATES).toContain('blocked_budget');
      expect(SCHEDULER_STATES).toContain('blocked_resource');
      expect(SCHEDULER_STATES).toContain('blocked_human');
      expect(SCHEDULER_STATES).toContain('waiting_delivery');
      expect(SCHEDULER_STATES).toContain('stalled');
      expect(SCHEDULER_STATES).toContain('running');
      expect(SCHEDULER_STATES).toContain('completed');
      expect(SCHEDULER_STATES).toContain('failed');
      expect(SCHEDULER_STATES).toContain('cancelled');
    });
  });

  describe('isMissionStateEntryType', () => {
    it('returns true for all valid entry types', () => {
      for (const type of MISSION_STATE_ENTRY_TYPES) {
        expect(isMissionStateEntryType(type)).toBe(true);
      }
    });

    it('covers all 7 entry types', () => {
      expect(MISSION_STATE_ENTRY_TYPES).toHaveLength(7);
      expect(MISSION_STATE_ENTRY_TYPES).toContain('decision');
      expect(MISSION_STATE_ENTRY_TYPES).toContain('assumption');
      expect(MISSION_STATE_ENTRY_TYPES).toContain('fact');
      expect(MISSION_STATE_ENTRY_TYPES).toContain('contract');
      expect(MISSION_STATE_ENTRY_TYPES).toContain('artifact_ref');
      expect(MISSION_STATE_ENTRY_TYPES).toContain('risk');
      expect(MISSION_STATE_ENTRY_TYPES).toContain('todo');
    });
  });
});
