import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import * as projectDataService from './project-data';
import {
  classifySessionIdleness,
  parseHarnessWorkConfig,
  type SessionIdlenessActivityState,
} from './session-idleness';
import { idlenessStateChanged, sessionSleepDeferralReason } from './session-sleep-eligibility';
import { waitForFinalSessionSnapshot } from './session-sleep-snapshot-wait';
import {
  completeSleepTeardown,
  finishAlreadySleeping,
  finishSleepCleanup,
  loadSleepWorkspace,
  type SleepWorkspace,
  type SleepWorkspaceSessionResult,
} from './session-sleep-teardown';
import {
  beginSessionSnapshotStopping,
  claimSessionSnapshotSleep,
  DEFAULT_SESSION_SLEEP_AFTER_MS,
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
  const idleAfterMs = parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  const harnessWorkConfig = parseHarnessWorkConfig(env);
  // Point-of-no-return gates ask the SAFETY question only. Whoever called
  // `sleepWorkspaceSession` has already decided this session should sleep —
  // including the user pressing Sleep on a session that just went idle — so
  // re-imposing the unattended scheduler's idle interval here would reject
  // an explicit request for up to SESSION_SLEEP_AFTER_MS.
  const classifyGate = (state: SessionIdlenessActivityState | null) =>
    classifySessionIdleness({
      taskStatus: workspace.taskStatus,
      taskCompletedAt: workspace.taskCompletedAt,
      state,
      now: new Date(),
      idleAfterMs,
      harnessWorkConfig,
      policy: 'prompt-turn-ended',
    });
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

  const [agentSession] = await db
    .select({ id: schema.agentSessions.id, agentType: schema.agentSessions.agentType })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        inArray(schema.agentSessions.status, ['running', 'recovery', 'sleeping'])
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);
  if (!agentSession) {
    throw new Error('Workspace has no resumable agent session');
  }

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
  const claim = await claimSessionSnapshotSleep(db, env, {
    chatSessionId: workspace.chatSessionId,
    claimId,
    force: !input.sleepClaimId,
  });
  if (claim.status === 'unavailable') {
    throw new Error(`Workspace sleep claim unavailable: ${claim.reason}`);
  }

  let pointOfNoReturn = claim.phase === 'stopping';
  let verified = snapshot;
  try {
    if (!pointOfNoReturn) {
      verified = await verifyAndBeginSleepTeardown(env, workspace, agentSession, claimId);
      pointOfNoReturn = true;
    } else {
      // A stopping claim can survive a Worker crash or an older deployment.
      // Recheck it before retrying the runtime stop; a legacy degraded claim
      // must not become an authority to discard the still-live agent home.
      verified = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
      if (
        !verified ||
        verified.status !== 'available' ||
        verified.degradation !== 'none' ||
        verified.workspaceId !== workspace.id ||
        verified.agentSessionId !== agentSession.id ||
        verified.nodeId !== workspace.nodeId ||
        verified.runtime !== workspace.nodeRuntime ||
        verified.captureGeneration ||
        !(await verifySessionSnapshotArtifactsForSleep(env, verified))
      ) {
        throw new Error('Stopping claim lacks a complete verified workspace snapshot');
      }
    }

    verified = await completeSleepTeardown(env, workspace, agentSession, claimId, verified);
  } catch (error) {
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
