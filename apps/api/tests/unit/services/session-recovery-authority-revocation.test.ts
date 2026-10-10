import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  sessionRecoveryAuthorityRevoked,
  SessionRecoveryAuthorityRevokedError,
} from '../../../src/services/session-recovery-authority-revocation';

afterEach(() => {
  vi.restoreAllMocks();
});

const revocation = {
  check: 'project_event_wake_authority' as const,
  site: 'task_runner.assert_recovery_authority',
  taskId: 'task-1',
  projectId: 'project-1',
  chatSessionId: 'chat-1',
  recoveryAttemptId: 'wake-1',
  sourceTaskId: 'task-1',
  projectEventWake: { batchId: 'batch-1', subscriptionId: 'subscription-1' },
};

function databaseReturning(first: () => Promise<unknown>) {
  const bind = vi.fn(() => ({ first }));
  const prepare = vi.fn((_query: string) => ({ bind }));
  return { database: { prepare } as unknown as D1Database, prepare, bind };
}

function loggedRevocations(warn: ReturnType<typeof vi.spyOn>): Record<string, unknown>[] {
  return warn.mock.calls
    .map(([line]: unknown[]) => JSON.parse(String(line)) as Record<string, unknown>)
    .filter(
      (entry: Record<string, unknown>) => entry.event === 'session_recovery.authority_revoked'
    );
}

describe('sessionRecoveryAuthorityRevoked', () => {
  it('logs the refusing check with the snapshot claim it read and returns the refusal', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database, prepare, bind } = databaseReturning(async () => ({
      recovery_task_id: 'task-1',
      recovery_attempt_id: 'wake-1',
      recovery_status: 'waking',
      capture_generation: 'generation-7',
      sleep_status: 'sleeping',
    }));

    const error = await sessionRecoveryAuthorityRevoked(database, revocation);

    expect(error).toBeInstanceOf(SessionRecoveryAuthorityRevokedError);
    expect(error).toMatchObject({
      message: 'Session recovery authority was revoked',
      name: 'SessionRecoveryAuthorityRevokedError',
      check: 'project_event_wake_authority',
      permanent: true,
    });
    expect(prepare.mock.calls[0]?.[0]).toContain('FROM session_snapshots');
    expect(bind).toHaveBeenCalledWith('chat-1', 'project-1');
    const [entry] = loggedRevocations(warn);
    expect(entry).toMatchObject({
      level: 'warn',
      check: 'project_event_wake_authority',
      site: 'task_runner.assert_recovery_authority',
      taskId: 'task-1',
      projectId: 'project-1',
      chatSessionId: 'chat-1',
      recoveryAttemptId: 'wake-1',
      sourceTaskId: 'task-1',
      persistedRecoveryAttemptId: null,
      projectEventBatchId: 'batch-1',
      projectEventSubscriptionId: 'subscription-1',
      snapshotFound: true,
      snapshotRecoveryTaskId: 'task-1',
      snapshotRecoveryAttemptId: 'wake-1',
      snapshotRecoveryStatus: 'waking',
      snapshotCaptureGeneration: 'generation-7',
      snapshotSleepStatus: 'sleeping',
      snapshotReadError: null,
    });
    // Identifiers and lifecycle states only: nothing secret-bearing can ride along.
    expect(Object.keys(entry ?? {}).sort()).toEqual(
      [
        'check',
        'chatSessionId',
        'event',
        'level',
        'persistedRecoveryAttemptId',
        'projectEventBatchId',
        'projectEventSubscriptionId',
        'projectId',
        'recoveryAttemptId',
        'site',
        'snapshotCaptureGeneration',
        'snapshotFound',
        'snapshotReadError',
        'snapshotRecoveryAttemptId',
        'snapshotRecoveryStatus',
        'snapshotRecoveryTaskId',
        'snapshotSleepStatus',
        'sourceTaskId',
        'taskId',
        'timestamp',
      ].sort()
    );
  });

  it('still returns the refusal when the diagnostic read fails', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database } = databaseReturning(async () => {
      throw new Error('D1_ERROR: database is locked');
    });

    const error = await sessionRecoveryAuthorityRevoked(database, {
      ...revocation,
      check: 'recovery_attempt_not_current',
    });

    expect(error).toMatchObject({ check: 'recovery_attempt_not_current' });
    expect(loggedRevocations(warn)).toEqual([
      expect.objectContaining({
        check: 'recovery_attempt_not_current',
        snapshotFound: false,
        snapshotReadError: 'D1_ERROR: database is locked',
      }),
    ]);
  });

  it('reports a missing snapshot row as not found', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database } = databaseReturning(async () => null);

    await sessionRecoveryAuthorityRevoked(database, revocation);

    expect(loggedRevocations(warn)).toEqual([
      expect.objectContaining({ snapshotFound: false, snapshotRecoveryStatus: null }),
    ]);
  });

  it('skips the snapshot read when the refusal has no chat session', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const { database, prepare } = databaseReturning(async () => ({}));

    await sessionRecoveryAuthorityRevoked(database, {
      ...revocation,
      check: 'recovery_chat_session_missing',
      chatSessionId: null,
    });

    expect(prepare).not.toHaveBeenCalled();
    expect(loggedRevocations(warn)).toEqual([
      expect.objectContaining({
        check: 'recovery_chat_session_missing',
        chatSessionId: null,
        snapshotFound: false,
      }),
    ]);
  });
});
