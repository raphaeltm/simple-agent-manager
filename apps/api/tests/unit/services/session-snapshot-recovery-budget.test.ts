/**
 * Regression suite for the wake attempt budget.
 *
 * Incident (production, 2026-09-09): four sessions with complete, unexpired
 * snapshots became permanently unwakeable. `recovery_attempts` was a LIFETIME
 * cap consumed identically by failures that prove a snapshot cannot be restored
 * and by transient infrastructure failures that never reached the snapshot.
 * Session 516141ed burnt all three attempts in 34 minutes on the same
 * `hetzner API error (412): error during placement`, and every reset of the
 * counter requires a successful wake, a fresh capture, or a fresh sleep
 * transition — none of which a sleeping session can reach.
 *
 * These tests drive the REAL claim against a REAL SQL engine (`.claude/rules/28`,
 * `.claude/rules/62`): the predicate under test is a WHERE clause, so a mock
 * whose `.where()` ignores its arguments would pass with the fix deleted.
 */
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/d1';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import * as schema from '../../../src/db/schema';
import type { Env } from '../../../src/env';
import { deriveAgentActivityState } from '../../../src/services/agent-activity';
import {
  claimSessionSnapshotRecovery,
  failSessionSnapshotRecovery,
  hasRestorableSleepingSessionSnapshot,
} from '../../../src/services/session-snapshot-recovery-lifecycle';
import { isSessionResumable } from '../../../src/services/task-runtime-liveness';
import { createSchemaTables, createSqliteD1 } from '../../helpers/sqlite-d1';

const CHAT_SESSION_ID = 'chat-516141ed';
const USER_ID = 'user-1';
const PROJECT_ID = 'project-1';
const WORKSPACE_ID = 'workspace-1';
const MAX_ATTEMPTS = 3;
const DECAY_MS = 15 * 60 * 1000;
const NOW = new Date('2026-09-09T18:00:00.000Z');

/** The exact error that stranded session 516141ed three times in 34 minutes. */
const TRANSIENT_PLACEMENT_ERROR = 'hetzner API error (412): error during placement';

let sqlite: Database.Database;

function makeEnv(overrides: Partial<Env> = {}): Env {
  return {
    DATABASE: createSqliteD1(sqlite),
    SESSION_SNAPSHOT_RECOVERY_MAX_ATTEMPTS: String(MAX_ATTEMPTS),
    SESSION_SNAPSHOT_RECOVERY_ATTEMPT_DECAY_MS: String(DECAY_MS),
    ...overrides,
  } as Env;
}

function db() {
  return drizzle(createSqliteD1(sqlite), { schema });
}

function seedSleepingSnapshot(
  input: { recoveryAttempts?: number; recoveryFailedAt?: string | null } = {}
): void {
  sqlite
    .prepare(
      `INSERT INTO session_snapshots (
         id, project_id, workspace_id, user_id, chat_session_id, runtime,
         status, degradation, manifest_r2_key, expires_at, sleeping_at,
         sleep_status, recovery_status, recovery_attempts, recovery_failed_at,
         created_at, updated_at
       ) VALUES (?, ?, ?, ?, ?, 'vm', 'available', 'none', 'manifest', ?, ?,
                 'sleeping', ?, ?, ?, ?, ?)`
    )
    .run(
      'snapshot-1',
      PROJECT_ID,
      WORKSPACE_ID,
      USER_ID,
      CHAT_SESSION_ID,
      new Date(NOW.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString(),
      '2026-09-09T12:03:01.120Z',
      input.recoveryAttempts === undefined ? null : 'failed',
      input.recoveryAttempts ?? 0,
      input.recoveryFailedAt ?? null,
      '2026-09-09T12:00:00.000Z',
      '2026-09-09T12:37:21.894Z'
    );
}

function readSnapshot(): {
  recovery_attempts: number;
  recovery_failed_at: string | null;
  recovery_status: string | null;
} {
  return sqlite
    .prepare(
      `SELECT recovery_attempts, recovery_failed_at, recovery_status
         FROM session_snapshots WHERE chat_session_id = ?`
    )
    .get(CHAT_SESSION_ID) as never;
}

/** Minutes before `NOW`, as an ISO timestamp. */
function minutesAgo(minutes: number): string {
  return new Date(NOW.getTime() - minutes * 60 * 1000).toISOString();
}

afterEach(() => {
  vi.useRealTimers();
});

beforeEach(() => {
  sqlite = new Database(':memory:');
  createSchemaTables(sqlite, [
    schema.sessionSnapshots,
    schema.tasks,
    // Read by the claim's archive-migration fence.
    schema.projectDataSessionLocations,
  ]);
});

describe('wake attempt budget', () => {
  it('releases a spent budget once the last clean failure ages past the decay window', async () => {
    // The incident: three transient placement failures, the last one an hour ago.
    seedSleepingSnapshot({ recoveryAttempts: MAX_ATTEMPTS, recoveryFailedAt: minutesAgo(60) });

    const claim = await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-wake',
      now: NOW,
    });

    expect(claim).toEqual({ status: 'claimed', taskId: 'task-wake' });
  });

  it('starts a NEW burst rather than continuing the spent one', async () => {
    seedSleepingSnapshot({ recoveryAttempts: MAX_ATTEMPTS, recoveryFailedAt: minutesAgo(60) });

    await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-wake',
      now: NOW,
    });

    const row = readSnapshot();
    // 1, not MAX_ATTEMPTS + 1: the cap must still bound the next burst.
    expect(row.recovery_attempts).toBe(1);
    // Cleared, or every later claim would read as decayed and the cap would be gone.
    expect(row.recovery_failed_at).toBeNull();
  });

  it('still refuses a burst of failures inside the decay window', async () => {
    // The control. Without this, the suite passes with the cap deleted outright.
    seedSleepingSnapshot({ recoveryAttempts: MAX_ATTEMPTS, recoveryFailedAt: minutesAgo(5) });

    const claim = await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-wake',
      now: NOW,
    });

    expect(claim).toEqual({ status: 'unavailable', reason: 'recovery_attempts_exhausted' });
    expect(readSnapshot().recovery_attempts).toBe(MAX_ATTEMPTS);
  });

  it('does not release the budget for an attempt that never reported back', async () => {
    // A crashed or still-leased attempt leaves recovery_failed_at NULL. Releasing
    // on absence would launder a wedged claim into an unlimited retry.
    seedSleepingSnapshot({ recoveryAttempts: MAX_ATTEMPTS, recoveryFailedAt: null });

    const claim = await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-wake',
      now: NOW,
    });

    expect(claim).toEqual({ status: 'unavailable', reason: 'recovery_attempts_exhausted' });
  });

  it('leaves an unspent budget on the normal increment path', async () => {
    seedSleepingSnapshot({ recoveryAttempts: 1, recoveryFailedAt: minutesAgo(60) });

    await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-wake',
      now: NOW,
    });

    // Decayed, so the burst restarts at 1 rather than continuing to 2.
    expect(readSnapshot().recovery_attempts).toBe(1);
  });

  it('records the failure instant through the real failure writer', async () => {
    // Drives the production writer rather than seeding the column, so the test
    // notices if `failSessionSnapshotRecovery` stops maintaining it.
    seedSleepingSnapshot({ recoveryAttempts: 0 });
    await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-wake',
      now: NOW,
    });
    expect(readSnapshot().recovery_failed_at).toBeNull();

    await failSessionSnapshotRecovery(
      db(),
      makeEnv(),
      CHAT_SESSION_ID,
      'task-wake',
      TRANSIENT_PLACEMENT_ERROR
    );

    const row = readSnapshot();
    expect(row.recovery_status).toBe('failed');
    expect(row.recovery_failed_at).not.toBeNull();
  });

  it('recovers a session across three transient failures and a wait', async () => {
    // The whole incident, end to end, through production writers only. The
    // failure writer reads its own clock, so the clock — not the column — is
    // what this test controls (`.claude/rules/62`: drive the real writer).
    vi.useFakeTimers();
    seedSleepingSnapshot({ recoveryAttempts: 0 });

    // Three failures inside 34 minutes, exactly as production recorded them.
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const at = new Date(NOW.getTime() - (60 - attempt * 10) * 60 * 1000);
      vi.setSystemTime(at);
      const claim = await claimSessionSnapshotRecovery(db(), makeEnv(), {
        chatSessionId: CHAT_SESSION_ID,
        userId: USER_ID,
        taskId: `task-${attempt}`,
        now: at,
      });
      expect(claim.status).toBe('claimed');
      await failSessionSnapshotRecovery(
        db(),
        makeEnv(),
        CHAT_SESSION_ID,
        `task-${attempt}`,
        TRANSIENT_PLACEMENT_ERROR
      );
    }

    // The burst is spent: the fourth attempt, taken immediately, is refused.
    vi.setSystemTime(new Date(NOW.getTime() - 29 * 60 * 1000));
    const immediately = await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-4',
      now: new Date(NOW.getTime() - 29 * 60 * 1000),
    });
    expect(immediately).toEqual({
      status: 'unavailable',
      reason: 'recovery_attempts_exhausted',
    });

    // After the decay window the same session wakes again.
    vi.setSystemTime(NOW);
    const afterWait = await claimSessionSnapshotRecovery(db(), makeEnv(), {
      chatSessionId: CHAT_SESSION_ID,
      userId: USER_ID,
      taskId: 'task-5',
      now: NOW,
    });

    expect(afterWait).toEqual({ status: 'claimed', taskId: 'task-5' });
  });
});

describe('consumers that mirror the budget', () => {
  it('hasRestorableSleepingSessionSnapshot sees a decayed budget as restorable', async () => {
    seedSleepingSnapshot({ recoveryAttempts: MAX_ATTEMPTS, recoveryFailedAt: minutesAgo(60) });

    await expect(
      hasRestorableSleepingSessionSnapshot(createSqliteD1(sqlite), makeEnv(), {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        chatSessionId: CHAT_SESSION_ID,
        now: NOW,
      })
    ).resolves.toBe(true);
  });

  it('hasRestorableSleepingSessionSnapshot still refuses an undecayed burst', async () => {
    seedSleepingSnapshot({ recoveryAttempts: MAX_ATTEMPTS, recoveryFailedAt: minutesAgo(5) });

    await expect(
      hasRestorableSleepingSessionSnapshot(createSqliteD1(sqlite), makeEnv(), {
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        chatSessionId: CHAT_SESSION_ID,
        now: NOW,
      })
    ).resolves.toBe(false);
  });

  it('the destroyer withholds a terminal verdict while the resumer would still wake', () => {
    // `.claude/rules/58`: a widened resumer with an un-widened classifier means the
    // sweep terminalizes tasks whose sessions are demonstrably restorable.
    const resumable = isSessionResumable(
      {
        chatSessionId: CHAT_SESSION_ID,
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        sleepingAt: NOW.getTime() - 60 * 60 * 1000,
        sleepStatus: 'sleeping',
        expiresAtMs: NOW.getTime() + 60 * 60 * 1000,
        status: 'available',
        degradation: 'none',
        recoveryAttempts: MAX_ATTEMPTS,
        recoveryFailedAtMs: NOW.getTime() - 60 * 60 * 1000,
      },
      PROJECT_ID,
      WORKSPACE_ID,
      MAX_ATTEMPTS,
      NOW.getTime(),
      DECAY_MS
    );

    expect(resumable).toBe(true);
  });

  it('the destroyer still terminalizes an undecayed exhausted burst', () => {
    const resumable = isSessionResumable(
      {
        chatSessionId: CHAT_SESSION_ID,
        projectId: PROJECT_ID,
        workspaceId: WORKSPACE_ID,
        sleepingAt: NOW.getTime() - 60 * 60 * 1000,
        sleepStatus: 'sleeping',
        expiresAtMs: NOW.getTime() + 60 * 60 * 1000,
        status: 'available',
        degradation: 'none',
        recoveryAttempts: MAX_ATTEMPTS,
        recoveryFailedAtMs: NOW.getTime() - 60 * 1000,
      },
      PROJECT_ID,
      WORKSPACE_ID,
      MAX_ATTEMPTS,
      NOW.getTime(),
      DECAY_MS
    );

    expect(resumable).toBe(false);
  });

  it('agent activity reports a decayed-budget session as still sleeping', () => {
    const row = {
      status: 'in_progress' as const,
      executionStep: null,
      workspaceStatus: 'deleted',
      supersededByTaskId: null,
      snapshotSleepStatus: 'sleeping',
      snapshotSleepingAt: '2026-09-09T12:03:01.120Z',
      snapshotStatus: 'available',
      snapshotDegradation: 'none',
      snapshotExpiresAt: new Date(NOW.getTime() + 60 * 60 * 1000).toISOString(),
      snapshotRecoveryAttempts: MAX_ATTEMPTS,
      snapshotRecoveryFailedAt: minutesAgo(60),
    };

    expect(deriveAgentActivityState(row, MAX_ATTEMPTS, NOW.getTime(), DECAY_MS)).toBe('sleeping');
    expect(
      deriveAgentActivityState(
        { ...row, snapshotRecoveryFailedAt: minutesAgo(5) },
        MAX_ATTEMPTS,
        NOW.getTime(),
        DECAY_MS
      )
    ).not.toBe('sleeping');
  });
});
