import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import * as projectDataService from './project-data';
import {
  idlenessStateChanged,
  sessionSleepDeferralReason,
  sleepTeardownSafetyGate,
} from './session-sleep-eligibility';
import { persistSessionSleepFallbackNotice } from './session-sleep-fallback-notices';
import { confirmSessionSleepFallbackStopping } from './session-sleep-recovery-point';
import { waitForFinalSessionSnapshot } from './session-sleep-snapshot-wait';
import {
  completeSleepTeardown,
  finishAlreadySleeping,
  finishSleepCleanup,
  loadResumableAgentSession,
  loadSleepWorkspace,
  type SleepWorkspace,
  type SleepWorkspaceSessionResult,
} from './session-sleep-teardown';
import {
  beginSessionSnapshotStopping,
  claimSessionSnapshotSleep,
  deferSessionSnapshotStopping,
  ensureSessionSnapshotForSleep,
  failSessionSnapshotSleepBeforeTeardown,
  getRestorableSessionSnapshot,
  isSessionSnapshotSleepReleasable,
  verifySessionSnapshotArtifactsForSleep,
} from './session-snapshots';

export type { SleepWorkspaceSessionResult } from './session-sleep-teardown';

async function verifyAndBeginSleepTeardown(
  env: Env,
  workspace: SleepWorkspace,
  agentSession: { id: string; agentType: string | null },
  claimId: string
) {
  const db = drizzle(env.DATABASE, { schema });
  const stateBefore = await projectDataService.getSessionState(
    env,
    workspace.projectId,
    agentSession.id
  );
  const classifyGate = sleepTeardownSafetyGate(env, workspace);
  const idlenessBefore = classifyGate(stateBefore);
  if (!stateBefore || !idlenessBefore.idle) {
    throw new Error(sessionSleepDeferralReason(idlenessBefore, stateBefore));
  }
  const acpSessionBefore = await projectDataService
    .getAcpSession(env, workspace.projectId, agentSession.id)
    .catch(() => null);

  const finalGeneration = await waitForFinalSessionSnapshot(db, env, {
    nodeId: workspace.nodeId,
    workspaceId: workspace.id,
    agentSessionId: agentSession.id,
    chatSessionId: workspace.chatSessionId,
    runtime: workspace.nodeRuntime,
    agentType: agentSession.agentType ?? undefined,
    acpSessionId: typeof acpSessionBefore?.id === 'string' ? acpSessionBefore.id : undefined,
    userId: workspace.userId,
  });

  const verified = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
  if (
    !isSessionSnapshotSleepReleasable(verified) ||
    verified.status !== 'available' ||
    verified.degradation !== 'none' ||
    verified.workspaceId !== workspace.id ||
    verified.agentSessionId !== agentSession.id ||
    verified.nodeId !== workspace.nodeId ||
    verified.runtime !== workspace.nodeRuntime ||
    verified.snapshotGeneration !== finalGeneration ||
    verified.captureGeneration
  ) {
    throw new Error(
      'Workspace snapshot completion was not durably verified (complete final generation required)'
    );
  }
  const stateAfter = await projectDataService.getSessionState(
    env,
    workspace.projectId,
    agentSession.id
  );
  if (
    !stateAfter ||
    !classifyGate(stateAfter).idle ||
    idlenessStateChanged(stateBefore, stateAfter)
  ) {
    throw new Error('Workspace activity changed while the final snapshot was captured');
  }
  if (!(await verifySessionSnapshotArtifactsForSleep(env, verified))) {
    throw new Error('Workspace snapshot artifacts failed durable R2 verification');
  }
  // R2 verification is asynchronous. Re-read immediately before the
  // stopping CAS; an active/settling callback also cancels the preparing
  // claim, so either boundary prevents newly hidden harness work from
  // crossing the point of no return.
  const stateAtStop = await projectDataService.getSessionState(
    env,
    workspace.projectId,
    agentSession.id
  );
  if (
    !stateAtStop ||
    !classifyGate(stateAtStop).idle ||
    idlenessStateChanged(stateAfter, stateAtStop)
  ) {
    throw new Error('Workspace activity changed during snapshot artifact verification');
  }
  if (
    !(await beginSessionSnapshotStopping(db, workspace.chatSessionId, claimId, finalGeneration))
  ) {
    throw new Error('Workspace sleep claim was cancelled before teardown');
  }
  return verified;
}

/**
 * Persist a sleep intent without touching the live runtime. Terminal completion
 * uses a zero delay while it is still inside the final ACP prompt; the scheduled
 * sweep performs the snapshot and teardown after ProjectData reports idle.
 */
export async function sleepWorkspaceSession(
  env: Env,
  input: { workspaceId: string; userId: string; reason: string; sleepClaimId?: string }
): Promise<SleepWorkspaceSessionResult> {
  const db = drizzle(env.DATABASE, { schema });
  const workspace = await loadSleepWorkspace(env, input.workspaceId, input.userId);
  const snapshot = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
  const alreadySleeping = await finishAlreadySleeping(db, env, workspace, snapshot);
  if (alreadySleeping) return alreadySleeping;

  if (!['running', 'recovery', 'sleeping'].includes(workspace.status)) {
    throw new Error(`Workspace cannot sleep from status ${workspace.status}`);
  }

  const agentSession = await loadResumableAgentSession(db, workspace.id);

  await ensureSessionSnapshotForSleep(db, env, {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    projectId: workspace.projectId,
    userId: workspace.userId,
    chatSessionId: workspace.chatSessionId,
    agentSessionId: agentSession.id,
    runtime: workspace.nodeRuntime,
  });

  const claimId = input.sleepClaimId ?? ulid();
  // Only the explicit sleep route (the Sleep button) calls without a claim id.
  const requestedByPerson = !input.sleepClaimId;
  const claim = await claimSessionSnapshotSleep(db, env, {
    chatSessionId: workspace.chatSessionId,
    claimId,
    force: requestedByPerson,
    reopenBlockedEpisode: requestedByPerson,
  });
  if (claim.status === 'unavailable') {
    throw new Error(`Workspace sleep claim unavailable: ${claim.reason}`);
  }

  const sleepPhaseStartedAt = Date.now();
  let teardownStartedAt: number | null = null;
  let pointOfNoReturn = claim.phase === 'stopping';
  let verified = snapshot;
  let fallback = false;
  try {
    if (!pointOfNoReturn) {
      verified = await verifyAndBeginSleepTeardown(env, workspace, agentSession, claimId);
      pointOfNoReturn = true;
    } else {
      // A stopping claim can survive a Worker crash or an older deployment.
      // Recheck it before retrying the runtime stop; a legacy degraded claim
      // must not become an authority to discard the still-live agent home.
      // A bounded fallback's claim carries its own recorded recovery point,
      // which is re-verified instead (`confirmSessionSleepFallbackStopping`).
      verified = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
      const identityMatches =
        Boolean(verified) &&
        verified?.workspaceId === workspace.id &&
        verified.agentSessionId === agentSession.id &&
        verified.nodeId === workspace.nodeId &&
        verified.runtime === workspace.nodeRuntime &&
        !verified.captureGeneration;
      const fallbackRecord =
        identityMatches && verified?.sleepFallbackJson
          ? await confirmSessionSleepFallbackStopping(env, verified, new Date())
          : null;
      if (fallbackRecord && verified) {
        // The notice may not have landed before the crash; the write is idempotent.
        await persistSessionSleepFallbackNotice(env, {
          projectId: workspace.projectId,
          chatSessionId: workspace.chatSessionId,
          record: fallbackRecord,
        });
        fallback = true;
      } else if (
        !identityMatches ||
        !verified ||
        verified.status !== 'available' ||
        verified.degradation !== 'none' ||
        !(await verifySessionSnapshotArtifactsForSleep(env, verified))
      ) {
        throw new Error('Stopping claim lacks a complete verified workspace snapshot');
      }
    }

    teardownStartedAt = Date.now();
    log.info('session_lifecycle.sleep_phase', {
      workspaceId: workspace.id,
      phase: 'snapshot_verify',
      durationMs: teardownStartedAt - sleepPhaseStartedAt,
      outcome: 'success',
    });
    verified = await completeSleepTeardown(env, workspace, agentSession, claimId, verified, {
      fallback,
    });
    log.info('session_lifecycle.sleep_phase', {
      workspaceId: workspace.id,
      phase: 'teardown',
      durationMs: Date.now() - teardownStartedAt,
      outcome: 'success',
    });
  } catch (error) {
    log.info('session_lifecycle.sleep_phase', {
      workspaceId: workspace.id,
      phase: teardownStartedAt === null ? 'snapshot_verify' : 'teardown',
      durationMs: Date.now() - (teardownStartedAt ?? sleepPhaseStartedAt),
      outcome: 'error',
    });
    const message = error instanceof Error ? error.message : String(error);
    if (pointOfNoReturn) {
      await deferSessionSnapshotStopping(db, env, workspace.chatSessionId, claimId, message);
    } else {
      await failSessionSnapshotSleepBeforeTeardown(
        db,
        env,
        workspace.chatSessionId,
        claimId,
        message
      );
    }
    throw error;
  }

  return finishSleepCleanup(db, env, workspace, agentSession, verified, input.reason);
}
