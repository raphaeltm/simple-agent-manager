/**
 * Unit tests for ACP session state machine (Spec 027).
 *
 * Tests the state machine transition rules defined in shared types.
 * These are pure logic tests — no Miniflare or SQL storage needed.
 */
import type { AcpSessionStatus } from '@simple-agent-manager/shared';
import {
  ACP_SESSION_DEFAULTS,
  ACP_SESSION_TERMINAL_STATUSES,
  ACP_SESSION_VALID_TRANSITIONS,
} from '@simple-agent-manager/shared';
import { describe, expect,it } from 'vitest';

const ALL_STATUSES: AcpSessionStatus[] = [
  'pending',
  'assigned',
  'running',
  'completed',
  'failed',
  'interrupted',
];

describe('ACP Session State Machine', () => {
  describe('valid transitions', () => {
    it('pending can only transition to assigned', () => {
      expect(ACP_SESSION_VALID_TRANSITIONS.pending).toEqual(['assigned']);
    });

    it('assigned can transition to running, failed, or interrupted', () => {
      expect(ACP_SESSION_VALID_TRANSITIONS.assigned).toEqual(['running', 'failed', 'interrupted']);
    });

    it('running can transition to completed, failed, or interrupted', () => {
      expect(ACP_SESSION_VALID_TRANSITIONS.running).toEqual([
        'completed',
        'failed',
        'interrupted',
      ]);
    });

    it('terminal states have no valid transitions', () => {
      for (const status of ACP_SESSION_TERMINAL_STATUSES) {
        expect(ACP_SESSION_VALID_TRANSITIONS[status]).toEqual([]);
      }
    });
  });

  describe('transition validation logic', () => {
    function isValidTransition(from: AcpSessionStatus, to: AcpSessionStatus): boolean {
      return ACP_SESSION_VALID_TRANSITIONS[from].includes(to);
    }

    // Valid forward transitions
    it.each([
      ['pending', 'assigned'],
      ['assigned', 'running'],
      ['assigned', 'failed'],
      ['assigned', 'interrupted'],
      ['running', 'completed'],
      ['running', 'failed'],
      ['running', 'interrupted'],
    ] as [AcpSessionStatus, AcpSessionStatus][])(
      'allows %s → %s',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(true);
      }
    );

    // Invalid backward transitions
    it.each([
      ['assigned', 'pending'],
      ['running', 'assigned'],
      ['running', 'pending'],
      ['completed', 'running'],
      ['failed', 'running'],
      ['interrupted', 'running'],
    ] as [AcpSessionStatus, AcpSessionStatus][])(
      'rejects %s → %s (backward)',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(false);
      }
    );

    // Invalid skip transitions
    it.each([
      ['pending', 'running'],
      ['pending', 'completed'],
      ['pending', 'failed'],
      ['pending', 'interrupted'],
    ] as [AcpSessionStatus, AcpSessionStatus][])(
      'rejects %s → %s (skip)',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(false);
      }
    );

    // Self-transitions
    it('rejects self-transitions for all states', () => {
      for (const status of ALL_STATUSES) {
        expect(isValidTransition(status, status)).toBe(false);
      }
    });
  });

  describe('terminal states', () => {
    it('completed, failed, and interrupted are terminal', () => {
      expect(ACP_SESSION_TERMINAL_STATUSES).toEqual(['completed', 'failed', 'interrupted']);
    });

    it('pending, assigned, and running are NOT terminal', () => {
      for (const status of ['pending', 'assigned', 'running'] as AcpSessionStatus[]) {
        expect(ACP_SESSION_TERMINAL_STATUSES.includes(status)).toBe(false);
      }
    });
  });

  describe('comprehensive invalid transitions', () => {
    function isValidTransition(from: AcpSessionStatus, to: AcpSessionStatus): boolean {
      return ACP_SESSION_VALID_TRANSITIONS[from].includes(to);
    }

    // Every possible transition from terminal states
    it.each(
      ACP_SESSION_TERMINAL_STATUSES.flatMap((terminal) =>
        ALL_STATUSES.filter((s) => s !== terminal).map(
          (target) => [terminal, target] as [AcpSessionStatus, AcpSessionStatus]
        )
      )
    )('rejects %s → %s (from terminal)', (from, to) => {
      expect(isValidTransition(from, to)).toBe(false);
    });

    // Every impossible transition from non-terminal states
    it.each([
      ['pending', 'running'],
      ['pending', 'completed'],
      ['pending', 'failed'],
      ['pending', 'interrupted'],
      ['assigned', 'pending'],
      ['assigned', 'completed'],
      ['running', 'pending'],
      ['running', 'assigned'],
    ] as [AcpSessionStatus, AcpSessionStatus][])(
      'rejects %s → %s (invalid non-terminal)',
      (from, to) => {
        expect(isValidTransition(from, to)).toBe(false);
      }
    );
  });

  describe('fork depth validation', () => {
    it('MAX_FORK_DEPTH is a positive integer', () => {
      expect(ACP_SESSION_DEFAULTS.MAX_FORK_DEPTH).toBeGreaterThan(0);
      expect(Number.isInteger(ACP_SESSION_DEFAULTS.MAX_FORK_DEPTH)).toBe(true);
    });

    it('all terminal statuses are forkable candidates', () => {
      // Fork is allowed from any terminal state
      for (const status of ACP_SESSION_TERMINAL_STATUSES) {
        expect(['completed', 'failed', 'interrupted']).toContain(status);
      }
    });
  });

  describe('configurable defaults', () => {
    it('has sensible default values', () => {
      expect(ACP_SESSION_DEFAULTS.HEARTBEAT_INTERVAL_MS).toBe(60_000);
      expect(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS).toBe(300_000);
      expect(ACP_SESSION_DEFAULTS.RECONCILIATION_TIMEOUT_MS).toBe(30_000);
      expect(ACP_SESSION_DEFAULTS.FORK_CONTEXT_MESSAGES).toBe(20);
      expect(ACP_SESSION_DEFAULTS.MAX_FORK_DEPTH).toBe(10);
    });

    it('detection window is greater than heartbeat interval', () => {
      expect(ACP_SESSION_DEFAULTS.DETECTION_WINDOW_MS).toBeGreaterThan(
        ACP_SESSION_DEFAULTS.HEARTBEAT_INTERVAL_MS
      );
    });
  });
});
