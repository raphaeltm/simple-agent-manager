/**
 * Behavioral tests for node stop/delete related helpers.
 *
 * The original source-contract tests verified architectural invariants
 * (consistent 'deleted' status across files) by reading source as strings.
 * These replacement tests verify observable behavior of exported functions.
 *
 * Full integration testing of stopNodeResources (which requires real
 * provider APIs, D1, and DNS) is covered by staging verification.
 */
import { describe, expect, it } from 'vitest';

import {
  ACTIVE_WORKSPACE_STATUSES,
  isActiveWorkspaceStatus,
  normalizeWorkspaceReadyStatus,
} from '../../../src/routes/workspaces/_helpers';

describe('ACTIVE_WORKSPACE_STATUSES', () => {
  it('includes running and recovery', () => {
    expect(ACTIVE_WORKSPACE_STATUSES.has('running')).toBe(true);
    expect(ACTIVE_WORKSPACE_STATUSES.has('recovery')).toBe(true);
  });

  it('excludes deleted status', () => {
    expect(ACTIVE_WORKSPACE_STATUSES.has('deleted' as any)).toBe(false);
  });

  it('excludes stopped status', () => {
    expect(ACTIVE_WORKSPACE_STATUSES.has('stopped' as any)).toBe(false);
  });

  it('excludes error status', () => {
    expect(ACTIVE_WORKSPACE_STATUSES.has('error' as any)).toBe(false);
  });
});

describe('isActiveWorkspaceStatus', () => {
  it('returns true for running', () => {
    expect(isActiveWorkspaceStatus('running')).toBe(true);
  });

  it('returns true for recovery', () => {
    expect(isActiveWorkspaceStatus('recovery')).toBe(true);
  });

  it('returns false for deleted', () => {
    expect(isActiveWorkspaceStatus('deleted')).toBe(false);
  });

  it('returns false for stopped', () => {
    expect(isActiveWorkspaceStatus('stopped')).toBe(false);
  });

  it('returns false for creating', () => {
    expect(isActiveWorkspaceStatus('creating')).toBe(false);
  });
});

describe('normalizeWorkspaceReadyStatus', () => {
  it('returns running for undefined input', () => {
    expect(normalizeWorkspaceReadyStatus(undefined)).toBe('running');
  });

  it('returns running for empty string', () => {
    expect(normalizeWorkspaceReadyStatus('')).toBe('running');
  });

  it('returns running for "running" input', () => {
    expect(normalizeWorkspaceReadyStatus('running')).toBe('running');
  });

  it('returns recovery for "recovery" input', () => {
    expect(normalizeWorkspaceReadyStatus('recovery')).toBe('recovery');
  });

  it('handles case-insensitive input', () => {
    expect(normalizeWorkspaceReadyStatus('RUNNING')).toBe('running');
    expect(normalizeWorkspaceReadyStatus('Recovery')).toBe('recovery');
  });

  it('trims whitespace', () => {
    expect(normalizeWorkspaceReadyStatus('  running  ')).toBe('running');
  });

  it('throws for invalid status values', () => {
    expect(() => normalizeWorkspaceReadyStatus('deleted')).toThrow('status must be');
    expect(() => normalizeWorkspaceReadyStatus('stopped')).toThrow('status must be');
  });
});
