import { describe, expect, it } from 'vitest';
import type { AgentSession } from '@simple-agent-manager/shared';
import { isSessionActive, isOrphanedSession } from '../../../src/lib/session-utils';

function makeSession(
  overrides: Partial<AgentSession> = {}
): AgentSession {
  return {
    id: 'sess-1',
    workspaceId: 'ws-1',
    status: 'running',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('isSessionActive', () => {
  it('returns true when status is running (no hostStatus)', () => {
    expect(isSessionActive(makeSession({ status: 'running' }))).toBe(true);
  });

  it('returns true when status is running even if hostStatus is stopped', () => {
    expect(
      isSessionActive(makeSession({ status: 'running', hostStatus: 'stopped' }))
    ).toBe(true);
  });

  it('returns true when status is stopped but hostStatus is ready (orphan)', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped', hostStatus: 'ready' }))
    ).toBe(true);
  });

  it('returns true when status is stopped but hostStatus is prompting', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped', hostStatus: 'prompting' }))
    ).toBe(true);
  });

  it('returns true when status is stopped but hostStatus is idle', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped', hostStatus: 'idle' }))
    ).toBe(true);
  });

  it('returns true when status is stopped but hostStatus is starting', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped', hostStatus: 'starting' }))
    ).toBe(true);
  });

  it('returns false when status is stopped and hostStatus is stopped', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped', hostStatus: 'stopped' }))
    ).toBe(false);
  });

  it('returns false when status is stopped and hostStatus is error', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped', hostStatus: 'error' }))
    ).toBe(false);
  });

  it('returns false when status is stopped and hostStatus is null', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped', hostStatus: null }))
    ).toBe(false);
  });

  it('returns false when status is stopped and hostStatus is undefined', () => {
    expect(
      isSessionActive(makeSession({ status: 'stopped' }))
    ).toBe(false);
  });

  it('returns true when status is error but hostStatus is ready', () => {
    expect(
      isSessionActive(makeSession({ status: 'error', hostStatus: 'ready' }))
    ).toBe(true);
  });
});

describe('isOrphanedSession', () => {
  it('returns false when status is running (normal session, not orphaned)', () => {
    expect(
      isOrphanedSession(makeSession({ status: 'running', hostStatus: 'ready' }))
    ).toBe(false);
  });

  it('returns true when status is stopped but hostStatus is ready', () => {
    expect(
      isOrphanedSession(makeSession({ status: 'stopped', hostStatus: 'ready' }))
    ).toBe(true);
  });

  it('returns true when status is error but hostStatus is prompting', () => {
    expect(
      isOrphanedSession(makeSession({ status: 'error', hostStatus: 'prompting' }))
    ).toBe(true);
  });

  it('returns false when status is stopped and hostStatus is null', () => {
    expect(
      isOrphanedSession(makeSession({ status: 'stopped', hostStatus: null }))
    ).toBe(false);
  });

  it('returns false when status is stopped and hostStatus is stopped', () => {
    expect(
      isOrphanedSession(makeSession({ status: 'stopped', hostStatus: 'stopped' }))
    ).toBe(false);
  });

  it('returns false when status is running (regardless of hostStatus)', () => {
    expect(
      isOrphanedSession(makeSession({ status: 'running' }))
    ).toBe(false);
  });
});
