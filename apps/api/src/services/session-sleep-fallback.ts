/**
 * The bounded sleep fallback: release an idle VM session's compute after its sleep
 * episode ran out of full-snapshot attempts, keeping the transcript and an exact,
 * restorable Git recovery point instead of the whole filesystem
 * (`session-sleep-episode.ts`, policy `a3780107` as clarified 2026-10-04).
 *
 * Order matters, and every step before the point of no return is reversible:
 *
 * 1. Claim the session (the same CAS every sleep uses).
 * 2. Safety: the prompt turn ended and no agent work is in flight. Otherwise defer
 *    without spending the budget.
 * 3. Abandon any capture still in flight, so a late upload or completion from a slow
 *    or pre-fix agent cannot change the recovery point underneath the decision.
 * 4. Require the minimum (`assessSessionSleepRecoveryPoint`): the current generation
 *    records the exact commit and keeps its objects. Without it the episode ends
 *    blocked — no teardown, a notice in the chat, and no more expensive captures.
 * 5. Confirm the transcript store holds the conversation, re-check idleness against
 *    the state from step 2, then cross into `stopping` with the decision recorded.
 *    A follow-up message cancels the claim and a completed capture changes the
 *    generation; either makes that CAS fail and nothing is torn down.
 * 6. Persist the notice into the conversation. If that write fails, step back to
 *    `failed` before any teardown I/O.
 * 7. Tear down through the same idempotent path a full sleep uses
 *    (`completeSleepTeardown`, `finishSleepCleanup`): only this session's workspace is
 *    stopped, its deletion is scheduled through the NodeLifecycle DO, and the node
 *    turns warm only when no other workspace is active on it.
 *
 * The wake that follows restores the files and Git state but starts a new agent session
 * from the transcript, never the saved one (`session-snapshot-restore-response.ts`).
 *
 * Instant (cf-container) runtimes end blocked instead: they wake in place and keep
 * their container only for a complete snapshot, so a Git-baseline wake is not
 * available to them yet (idea 01M434RYFTNQ0NY704JGJYHRT7).
 */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from './project-data';
import {
  classifySessionIdleness,
  parseHarnessWorkConfig,
  type SessionIdlenessActivityState,
} from './session-idleness';
import { idlenessStateChanged, sessionSleepDeferralReason } from './session-sleep-eligibility';
import {
  serializeSessionSleepFallbackRecord,
  type SessionSleepBlockedReason,
  type SessionSleepFallbackRecord,
  type SessionSleepFallbackTrigger,
} from './session-sleep-episode';
import {
  persistSessionSleepBlockedNotice,
  persistSessionSleepFallbackNotice,
} from './session-sleep-fallback-notices';
import {
  abandonSessionSnapshotCapture,
  beginSessionSnapshotFallbackStopping,
  type BlockedEpisodeExpectation,
  blockSessionSleepEpisode,
  revertSessionSnapshotFallbackStopping,
} from './session-sleep-fallback-state';
import { assessSessionSleepRecoveryPoint } from './session-sleep-recovery-point';
import {
  completeSleepTeardown,
  finishSleepCleanup,
  loadResumableAgentSession,
  loadSleepWorkspace,
  type SleepWorkspace,
} from './session-sleep-teardown';
import {
  claimSessionSnapshotSleep,
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  deferSessionSnapshotSleepBeforeClaim,
  deferSessionSnapshotStopping,
  failSessionSnapshotSleepBeforeTeardown,
  getRestorableSessionSnapshot,
  sessionLifecycleError,
} from './session-snapshots';

export type SessionSleepFallbackOutcome =
  /** Compute released; the session sleeps on its recovery point. */
  | 'slept'
  /** The episode ended without a recovery point; the runtime keeps running. */
  | 'blocked'
  /** A transient failure, counted against the episode; retried by a later sweep. */
  | 'retry'
  /** The session is not idle; nothing was spent. */
  | 'deferred'
  /** Another owner changed the row first; nothing was done. */
  | 'skipped';

export const SESSION_SLEEP_FALLBACK_REASON =
  'Bounded sleep fallback after repeated snapshot failures';

type Db = ReturnType<typeof drizzle<typeof schema>>;

async function loadEpisode(
  db: Db,
  chatSessionId: string
): Promise<{
  projectId: string | null;
  runtime: string;
  sleepEpisodeStartedAt: string | null;
  sleepEpisodeFailures: number | null;
  captureGeneration: string | null;
} | null> {
  return (
    (await db
      .select({
        projectId: schema.sessionSnapshots.projectId,
        runtime: schema.sessionSnapshots.runtime,
        sleepEpisodeStartedAt: schema.sessionSnapshots.sleepEpisodeStartedAt,
        sleepEpisodeFailures: schema.sessionSnapshots.sleepEpisodeFailures,
        captureGeneration: schema.sessionSnapshots.captureGeneration,
      })
      .from(schema.sessionSnapshots)
      .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
      .get()) ?? null
  );
}

/**
 * End the episode blocked and say so. `expected` is the CAS: the caller's own claim, or
 * the exact state the sweep observed at selection. Returns false when another owner
 * changed the row first.
 */
export async function endSessionSleepEpisodeBlocked(
  env: Env,
  input: {
    chatSessionId: string;
    reason: SessionSleepBlockedReason;
    trigger: SessionSleepFallbackTrigger;
    lastError: string | null;
    expected: BlockedEpisodeExpectation;
    now?: Date;
  }
): Promise<boolean> {
  const db = drizzle(env.DATABASE, { schema });
  const now = input.now ?? new Date();
  const episode = await loadEpisode(db, input.chatSessionId);
  if (!episode) return false;
  const record: SessionSleepFallbackRecord = {
    version: 1,
    outcome: 'blocked',
    trigger: input.trigger,
    blockedReason: input.reason,
    decidedAt: now.toISOString(),
    episodeStartedAt: episode.sleepEpisodeStartedAt,
    failedAttempts: episode.sleepEpisodeFailures ?? 0,
    lastError: input.lastError ? sessionLifecycleError(env, input.lastError) : null,
    recoveryPoint: null,
  };
  const blocked = await blockSessionSleepEpisode(db, env, {
    chatSessionId: input.chatSessionId,
    recordJson: serializeSessionSleepFallbackRecord(record),
    error: `Automatic sleep stopped after bounded snapshot failures (${input.reason})`,
    expected: input.expected,
    now,
  });
  if (!blocked) return false;
  log.warn('session_sleep.episode_blocked', {
    chatSessionId: input.chatSessionId,
    projectId: episode.projectId,
    runtime: episode.runtime,
    reason: input.reason,
    trigger: input.trigger,
    failedAttempts: record.failedAttempts,
    episodeStartedAt: record.episodeStartedAt,
  });
  if (episode.projectId) {
    await persistSessionSleepBlockedNotice(env, {
      projectId: episode.projectId,
      chatSessionId: input.chatSessionId,
      runtime: episode.runtime,
      record,
    });
  }
  return true;
}

function safetyGate(env: Env, workspace: SleepWorkspace) {
  const idleAfterMs = parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  const harnessWorkConfig = parseHarnessWorkConfig(env);
  // The SAFETY question only, as at every point of no return: has the agent handed
  // control back with nothing it started still in flight? The scheduling interval was
  // already enforced by the sweep's eligibility check.
  return (state: SessionIdlenessActivityState | null) =>
    classifySessionIdleness({
      taskStatus: workspace.taskStatus,
      taskCompletedAt: workspace.taskCompletedAt,
      state,
      now: new Date(),
      idleAfterMs,
      harnessWorkConfig,
      policy: 'prompt-turn-ended',
    });
}

/**
 * Run one fallback attempt for a session whose episode left the full phase. Never
 * throws: every outcome is recorded on the row and returned.
 */
export async function runSessionSleepFallback(
  env: Env,
  input: {
    workspaceId: string;
    userId: string;
    chatSessionId: string;
    claimId: string;
    trigger: SessionSleepFallbackTrigger;
    /** The failure that preceded this attempt; the claim clears the row's copy. */
    lastError: string | null;
    now?: Date;
  }
): Promise<SessionSleepFallbackOutcome> {
  const db = drizzle(env.DATABASE, { schema });
  const now = input.now ?? new Date();
  const { chatSessionId, claimId } = input;
  const workspace = await loadSleepWorkspace(env, input.workspaceId, input.userId);
  if (workspace.chatSessionId !== chatSessionId) return 'skipped';

  const claim = await claimSessionSnapshotSleep(db, env, { chatSessionId, claimId, now });
  if (claim.status !== 'claimed') return 'skipped';
  if (claim.phase === 'stopping') {
    // A teardown already crossed its point of no return: roll it forward, never
    // re-decide it. Loaded lazily to keep the full-sleep path free of this module.
    const { sleepWorkspaceSession } = await import('./session-sleep-execution');
    try {
      await sleepWorkspaceSession(env, {
        workspaceId: workspace.id,
        userId: workspace.userId,
        reason: SESSION_SLEEP_FALLBACK_REASON,
        sleepClaimId: claimId,
      });
      return 'slept';
    } catch {
      // `sleepWorkspaceSession` already deferred the stopping claim for a later sweep.
      return 'retry';
    }
  }

  let pointOfNoReturn = false;
  try {
    // No Git-baseline wake for Instant yet (idea 01M434RYFTNQ0NY704JGJYHRT7).
    if (workspace.nodeRuntime !== 'vm') {
      const blocked = await endSessionSleepEpisodeBlocked(env, {
        chatSessionId,
        reason: 'unsupported_runtime',
        trigger: input.trigger,
        lastError: input.lastError,
        expected: { kind: 'claim', claimId },
        now,
      });
      return blocked ? 'blocked' : 'skipped';
    }
    const agentSession = await loadResumableAgentSession(db, workspace.id);
    const classify = safetyGate(env, workspace);
    const stateBefore = await projectDataService.getSessionState(
      env,
      workspace.projectId,
      agentSession.id
    );
    const idlenessBefore = classify(stateBefore);
    if (!stateBefore || !idlenessBefore.idle) {
      await deferSessionSnapshotSleepBeforeClaim(
        db,
        env,
        chatSessionId,
        sessionSleepDeferralReason(idlenessBefore, stateBefore),
        idlenessBefore.retryAt,
        now,
        { expectedPreparingClaimId: claimId }
      );
      return 'deferred';
    }

    const inFlight = await loadEpisode(db, chatSessionId);
    if (inFlight?.captureGeneration) {
      await abandonSessionSnapshotCapture(db, env, {
        chatSessionId,
        generation: inFlight.captureGeneration,
        now,
      });
    }
    const snapshot = await getRestorableSessionSnapshot(db, chatSessionId, now);
    const assessment = await assessSessionSleepRecoveryPoint(env, snapshot, now);
    if (!assessment.ok) {
      const blocked = await endSessionSleepEpisodeBlocked(env, {
        chatSessionId,
        reason: assessment.reason,
        trigger: input.trigger,
        lastError: input.lastError,
        expected: { kind: 'claim', claimId },
        now,
      });
      return blocked ? 'blocked' : 'skipped';
    }

    // The transcript is the one thing the fallback promises to keep. A chat the
    // transcript store cannot find is a transient fault, not a reason to give up.
    const chat = await projectDataService.getSession(env, workspace.projectId, chatSessionId);
    if (!chat) throw new Error('ProjectData chat session is missing; transcript not confirmed');

    const stateAfter = await projectDataService.getSessionState(
      env,
      workspace.projectId,
      agentSession.id
    );
    if (
      !stateAfter ||
      !classify(stateAfter).idle ||
      idlenessStateChanged(stateBefore, stateAfter)
    ) {
      await deferSessionSnapshotSleepBeforeClaim(
        db,
        env,
        chatSessionId,
        'Workspace activity changed while the sleep fallback was prepared',
        undefined,
        now,
        { expectedPreparingClaimId: claimId }
      );
      return 'deferred';
    }

    const episode = await loadEpisode(db, chatSessionId);
    const record: SessionSleepFallbackRecord = {
      version: 1,
      outcome: 'slept',
      trigger: input.trigger,
      blockedReason: null,
      decidedAt: now.toISOString(),
      episodeStartedAt: episode?.sleepEpisodeStartedAt ?? null,
      failedAttempts: episode?.sleepEpisodeFailures ?? 0,
      lastError: input.lastError ? sessionLifecycleError(env, input.lastError) : null,
      recoveryPoint: assessment.recoveryPoint,
    };
    const recordJson = serializeSessionSleepFallbackRecord(record);
    const point = assessment.recoveryPoint;
    if (
      !snapshot ||
      !(await beginSessionSnapshotFallbackStopping(db, {
        chatSessionId,
        claimId,
        generation: point.generation,
        status: snapshot.status,
        degradation: snapshot.degradation,
        recordJson,
        now,
      }))
    ) {
      // A follow-up cancelled the claim, or a capture completed: nothing was torn down.
      // Hand a still-held claim back at once, so the next sweep re-decides with the
      // newer generation instead of waiting out the claim lease. A cancelled claim is
      // already gone and this write is then a no-op.
      await deferSessionSnapshotSleepBeforeClaim(
        db,
        env,
        chatSessionId,
        'Sleep fallback superseded by a newer snapshot generation',
        now,
        now,
        { expectedPreparingClaimId: claimId }
      );
      log.info('session_sleep.fallback_superseded', { chatSessionId, workspaceId: workspace.id });
      return 'skipped';
    }

    try {
      await persistSessionSleepFallbackNotice(env, {
        projectId: workspace.projectId,
        chatSessionId,
        record,
      });
    } catch (error) {
      const message = sessionLifecycleError(env, error);
      await revertSessionSnapshotFallbackStopping(db, env, {
        chatSessionId,
        claimId,
        error: `Sleep fallback notice could not be persisted: ${message}`,
        now,
      });
      log.warn('session_sleep.fallback_notice_failed', {
        chatSessionId,
        workspaceId: workspace.id,
        error: message,
      });
      return 'retry';
    }

    pointOfNoReturn = true;
    const slept = await completeSleepTeardown(env, workspace, agentSession, claimId, snapshot, {
      fallback: true,
    });
    await finishSleepCleanup(
      db,
      env,
      workspace,
      agentSession,
      slept,
      SESSION_SLEEP_FALLBACK_REASON
    );
    log.warn('session_sleep.fallback_slept', {
      chatSessionId,
      workspaceId: workspace.id,
      nodeId: workspace.nodeId,
      trigger: record.trigger,
      failedAttempts: record.failedAttempts,
      episodeStartedAt: record.episodeStartedAt,
      generation: point.generation,
      snapshotStatus: point.snapshotStatus,
      degradation: point.degradation,
      workingTreeSaved: point.workingTreeSaved,
      homeSaved: point.homeSaved,
    });
    return 'slept';
  } catch (error) {
    const message = sessionLifecycleError(env, error);
    const recorded = pointOfNoReturn
      ? deferSessionSnapshotStopping(db, env, chatSessionId, claimId, message, now)
      : failSessionSnapshotSleepBeforeTeardown(db, env, chatSessionId, claimId, message, now);
    await recorded.catch((persistenceError: unknown) => {
      log.error('session_sleep.fallback_failure_persistence_failed', {
        chatSessionId,
        workspaceId: workspace.id,
        error: sessionLifecycleError(env, persistenceError),
      });
    });
    log.warn('session_sleep.fallback_failed', {
      chatSessionId,
      workspaceId: workspace.id,
      pointOfNoReturn,
      error: message,
    });
    return 'retry';
  }
}
