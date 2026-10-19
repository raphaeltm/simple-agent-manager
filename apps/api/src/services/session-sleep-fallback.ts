/** Bounded snapshot failure releases idle compute while retaining chat and backups. */
import { eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import * as projectDataService from './project-data';
import {
  idlenessStateChanged,
  sessionSleepDeferralReason,
  sleepTeardownSafetyGate,
} from './session-sleep-eligibility';
import {
  serializeSessionSleepFallbackRecord,
  type SessionSleepBlockedReason,
  sessionSleepEpisodeConfig,
  sessionSleepEpisodeTrigger,
  type SessionSleepFallbackRecord,
  type SessionSleepFallbackTrigger,
} from './session-sleep-episode';
import { sleepWorkspaceSession } from './session-sleep-execution';
import {
  persistSessionSleepBlockedNotice,
  persistSessionSleepFallbackNotice,
} from './session-sleep-fallback-notices';
import { isRearmableSessionSleepBlock } from './session-sleep-fallback-record';
import {
  abandonSessionSnapshotCapture,
  beginSessionSnapshotFallbackStopping,
  type BlockedEpisodeExpectation,
  blockSessionSleepEpisode,
  revertSessionSnapshotFallbackStopping,
} from './session-sleep-fallback-state';
import { assessSessionSleepRecoveryPoint } from './session-sleep-recovery-point';
import { sessionSleepRuntimeChanged } from './session-sleep-runtime-identity';
import {
  completeSleepTeardown,
  finishSleepCleanup,
  loadResumableAgentSession,
  loadSleepWorkspace,
} from './session-sleep-teardown';
import {
  claimSessionSnapshotSleep,
  deferSessionSnapshotSleepBeforeClaim,
  deferSessionSnapshotStopping,
  failSessionSnapshotSleepBeforeTeardown,
  sanitizeSessionLifecycleMessage,
  sessionLifecycleError,
} from './session-snapshots';

export type SessionSleepFallbackOutcome =
  /** Compute released; the session sleeps on its recovery point. */
  | 'slept'
  /** Legacy blocked outcome retained for callers reading historical results. */
  | 'blocked'
  /** The old intent was blocked; the replacement runtime must be left alone. */
  | 'superseded'
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
    lastError: sanitizeSessionLifecycleMessage(env, input.lastError || null),
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

/**
 * Run one fallback attempt for a session whose episode left the full phase. Once it
 * holds the claim it does not throw: every outcome is recorded on the row and returned.
 * A failure before that (loading the workspace, the claim itself) has changed nothing,
 * and the sweep logs it and retries on a later tick.
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
    // re-decide it.
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
    // Discovery is only a hint: a replayed failure/wake may have reset the
    // episode before this claim. Recheck its current budget before any capture
    // abandonment or teardown; the claim fences later resets at the stopping CAS.
    const currentEpisode = await db
      .select()
      .from(schema.sessionSnapshots)
      .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
      .get();
    if (!currentEpisode || currentEpisode.sleepClaimId !== claimId) return 'skipped';
    const currentTrigger = sessionSleepEpisodeTrigger(
      currentEpisode,
      now,
      sessionSleepEpisodeConfig(env)
    );
    if (!currentTrigger && !isRearmableSessionSleepBlock(currentEpisode.sleepFallbackJson)) {
      await deferSessionSnapshotSleepBeforeClaim(
        db,
        env,
        chatSessionId,
        'Sleep episode changed after fallback selection',
        undefined,
        now,
        { expectedPreparingClaimId: claimId }
      );
      return 'deferred';
    }
    const fallbackTrigger = currentTrigger ?? input.trigger;
    const agentSession = await loadResumableAgentSession(db, workspace.id);
    const classify = sleepTeardownSafetyGate(env, workspace);
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
    // Read metadata even when no completed capture exists. Backups remain untouched.
    const snapshot = await db
      .select()
      .from(schema.sessionSnapshots)
      .where(eq(schema.sessionSnapshots.chatSessionId, chatSessionId))
      .get();
    if (
      !snapshot ||
      snapshot.workspaceId !== workspace.id ||
      snapshot.nodeId !== workspace.nodeId ||
      snapshot.userId !== workspace.userId ||
      snapshot.agentSessionId !== agentSession.id
    ) {
      throw new Error('Sleep fallback snapshot runtime identity changed');
    }
    // Verification is best effort after the bounded capture budget. A storage outage
    // must not convert the attempt ceiling into indefinite runtime retention.
    const assessment = await assessSessionSleepRecoveryPoint(env, snapshot, now).catch(() => ({
      ok: false as const,
      reason: 'commit_objects_unavailable' as const,
    }));

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
      trigger: fallbackTrigger,
      blockedReason: null,
      decidedAt: now.toISOString(),
      episodeStartedAt: episode?.sleepEpisodeStartedAt ?? null,
      failedAttempts: episode?.sleepEpisodeFailures ?? 0,
      lastError: sanitizeSessionLifecycleMessage(env, input.lastError || null),
      recoveryPoint:
        workspace.nodeRuntime === 'vm' && assessment.ok ? assessment.recoveryPoint : null,
    };
    const recordJson = serializeSessionSleepFallbackRecord(record);
    const point = record.recoveryPoint;
    if (
      !snapshot ||
      !(await beginSessionSnapshotFallbackStopping(db, {
        chatSessionId,
        claimId,
        generation: snapshot.snapshotGeneration,
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
      generation: snapshot.snapshotGeneration,
      snapshotStatus: point?.snapshotStatus,
      degradation: point?.degradation,
      workingTreeSaved: point?.workingTreeSaved,
      homeSaved: point?.homeSaved,
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
    if (pointOfNoReturn && sessionSleepRuntimeChanged(error)) {
      const { settleUnconfirmedSleepStop } = await import('./session-sleep-stopping-failure');
      await settleUnconfirmedSleepStop(env, chatSessionId, claimId, error, now);
      return 'superseded';
    }
    log.warn('session_sleep.fallback_failed', {
      chatSessionId,
      workspaceId: workspace.id,
      pointOfNoReturn,
      error: message,
    });
    return 'retry';
  }
}
