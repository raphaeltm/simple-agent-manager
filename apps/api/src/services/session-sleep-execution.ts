import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { stopWorkspaceOnNode } from './node-agent';
import * as projectDataService from './project-data';
import {
  classifySessionIdleness,
  parseHarnessWorkConfig,
  type SessionIdlenessActivityState,
} from './session-idleness';
import {
  finishSleepingWorkspaceComputeCleanup,
  markWorkspaceNodeWarmIfEmpty,
} from './session-sleep-cleanup';
import { idlenessStateChanged, sessionSleepDeferralReason } from './session-sleep-eligibility';
import { waitForFinalSessionSnapshot } from './session-sleep-snapshot-wait';
import {
  beginSessionSnapshotStopping,
  claimSessionSnapshotSleep,
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  deferSessionSnapshotStopping,
  ensureSessionSnapshotForSleep,
  failSessionSnapshotSleepBeforeTeardown,
  finalizeSessionSnapshotSleeping,
  getRestorableSessionSnapshot,
  isSessionSnapshotSleepReleasable,
  verifySessionSnapshotArtifactsForSleep,
} from './session-snapshots';
import { sleepVmAgentContainer } from './vm-agent-container';

export interface SleepWorkspaceSessionResult {
  status: 'sleeping';
  workspaceId: string;
  chatSessionId: string;
  snapshotExpiresAt: string;
}

async function loadSleepWorkspace(env: Env, workspaceId: string, userId: string) {
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      status: schema.workspaces.status,
      nodeId: schema.workspaces.nodeId,
      nodeRuntime: schema.nodes.runtime,
      nodeRole: schema.nodes.nodeRole,
      taskId: schema.tasks.id,
      taskStatus: schema.tasks.status,
      taskCompletedAt: sql<
        string | null
      >`COALESCE(${schema.tasks.completedAt}, ${schema.tasks.updatedAt})`,
      warmNodeTimeoutMs: schema.projects.warmNodeTimeoutMs,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .leftJoin(
      schema.sessionSummaries,
      eq(schema.sessionSummaries.id, schema.workspaces.chatSessionId)
    )
    .leftJoin(
      schema.tasks,
      or(
        eq(schema.tasks.id, schema.sessionSummaries.taskId),
        and(
          isNull(schema.sessionSummaries.taskId),
          eq(schema.tasks.chatSessionId, schema.workspaces.chatSessionId)
        )
      )
    )
    .leftJoin(schema.projects, eq(schema.projects.id, schema.workspaces.projectId))
    .where(and(eq(schema.workspaces.id, workspaceId), eq(schema.workspaces.userId, userId)))
    .limit(1);
  if (
    !workspace?.projectId ||
    !workspace.chatSessionId ||
    !workspace.nodeId ||
    !workspace.nodeRuntime
  ) {
    throw new Error('Workspace is missing persistent-session ownership metadata');
  }

  return {
    ...workspace,
    projectId: workspace.projectId,
    chatSessionId: workspace.chatSessionId,
    nodeId: workspace.nodeId,
    nodeRuntime: workspace.nodeRuntime,
  };
}

type SleepWorkspace = Awaited<ReturnType<typeof loadSleepWorkspace>>;

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

  await waitForFinalSessionSnapshot(db, env, {
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
  if (!isSessionSnapshotSleepReleasable(verified)) {
    throw new Error('Workspace snapshot completion was not durably verified');
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
  if (!(await beginSessionSnapshotStopping(db, workspace.chatSessionId, claimId))) {
    throw new Error('Workspace sleep claim was cancelled before teardown');
  }
  return verified;
}

async function ensureProjectDataSleeping(env: Env, workspace: SleepWorkspace): Promise<void> {
  const chatSession = await projectDataService.getSession(
    env,
    workspace.projectId,
    workspace.chatSessionId
  );
  if (!chatSession) throw new Error('ProjectData chat session is missing');
  if (chatSession.status === 'sleeping') return;
  const slept = await projectDataService.sleepSession(
    env,
    workspace.projectId,
    workspace.chatSessionId
  );
  if (slept) return;
  const repaired = await projectDataService.getSession(
    env,
    workspace.projectId,
    workspace.chatSessionId
  );
  if (repaired?.status !== 'sleeping') {
    throw new Error('ProjectData refused the durable sleeping transition');
  }
}

async function completeSleepTeardown(
  env: Env,
  workspace: SleepWorkspace,
  agentSession: { id: string },
  claimId: string,
  verified: Awaited<ReturnType<typeof getRestorableSessionSnapshot>>
) {
  const db = drizzle(env.DATABASE, { schema });
  await ensureProjectDataSleeping(env, workspace);

  // `stopping` is durable before this I/O. An interrupted or ambiguous stop
  // is retried forward; it is never rolled back to a deliverable active chat.
  if (workspace.nodeRuntime === 'cf-container') {
    await sleepVmAgentContainer(env, workspace.nodeId);
  } else {
    await stopWorkspaceOnNode(workspace.nodeId, workspace.id, env, workspace.userId);
  }

  const now = new Date().toISOString();
  const workspaceSleeping = db
    .update(schema.workspaces)
    .set({ status: 'sleeping', errorMessage: null, updatedAt: now })
    .where(
      and(
        eq(schema.workspaces.id, workspace.id),
        inArray(schema.workspaces.status, ['running', 'recovery', 'sleeping'])
      )
    );
  const agentSleeping = db
    .update(schema.agentSessions)
    .set({ status: 'sleeping', errorMessage: null, updatedAt: now })
    .where(eq(schema.agentSessions.id, agentSession.id));
  if (workspace.nodeRuntime === 'cf-container') {
    await db.batch([
      workspaceSleeping,
      agentSleeping,
      db
        .update(schema.nodes)
        .set({
          status: 'sleeping',
          healthStatus: 'unhealthy',
          errorMessage: null,
          updatedAt: now,
        })
        .where(eq(schema.nodes.id, workspace.nodeId)),
    ]);
  } else {
    await db.batch([workspaceSleeping, agentSleeping]);
  }
  const sleepWarning =
    verified?.status === 'degraded'
      ? `Workspace slept with degraded snapshot (${verified.degradation})`
      : null;
  const finalized = await finalizeSessionSnapshotSleeping(
    db,
    env,
    workspace.chatSessionId,
    claimId,
    new Date(),
    { sleepWarning }
  );
  if (!finalized) {
    const snapshot = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
    if (!snapshot?.sleepingAt || snapshot.sleepStatus !== 'sleeping') {
      throw new Error('Verified snapshot lost availability before sleep commit');
    }
  }
  const completed = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
  if (!completed?.sleepingAt || completed.sleepStatus !== 'sleeping') {
    throw new Error('Workspace sleep finalization was not durably verified');
  }
  return completed;
}

async function finishAlreadySleeping(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  workspace: SleepWorkspace,
  snapshot: Awaited<ReturnType<typeof getRestorableSessionSnapshot>>
): Promise<SleepWorkspaceSessionResult | null> {
  if (
    workspace.status === 'sleeping' &&
    isSessionSnapshotSleepReleasable(snapshot) &&
    snapshot.sleepStatus === 'sleeping' &&
    snapshot.sleepingAt
  ) {
    await projectDataService.sleepSession(env, workspace.projectId, workspace.chatSessionId);
    if (workspace.nodeRuntime !== 'cf-container') {
      const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(workspace.nodeId));
      await (stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle)
        .scheduleWorkspaceDeletion(workspace.nodeId, workspace.id, workspace.userId)
        .catch((error) => {
          log.warn('session_sleep.workspace_deletion_reschedule_failed', {
            workspaceId: workspace.id,
            nodeId: workspace.nodeId,
            error: error instanceof Error ? error.message : String(error),
          });
        });
    }
    await finishSleepingWorkspaceComputeCleanup(db, env, {
      workspaceId: workspace.id,
      taskId: workspace.taskId ?? null,
      warmNodeTimeoutMs: workspace.warmNodeTimeoutMs ?? null,
    });
    await markWorkspaceNodeWarmIfEmpty(db, env, {
      nodeId: workspace.nodeId,
      nodeRole: workspace.nodeRole ?? '',
      runtime: workspace.nodeRuntime,
      userId: workspace.userId,
      warmNodeTimeoutMs: workspace.warmNodeTimeoutMs ?? null,
    });
    return {
      status: 'sleeping',
      workspaceId: workspace.id,
      chatSessionId: workspace.chatSessionId,
      snapshotExpiresAt: snapshot.expiresAt,
    };
  }
  return null;
}

async function finishSleepCleanup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  workspace: SleepWorkspace,
  agentSession: { id: string },
  verified: NonNullable<Awaited<ReturnType<typeof getRestorableSessionSnapshot>>>,
  reason: string
): Promise<SleepWorkspaceSessionResult> {
  const acpSession = await projectDataService
    .getAcpSession(env, workspace.projectId, agentSession.id)
    .catch(() => null);
  if (acpSession?.status === 'running') {
    await projectDataService
      .transitionAcpSession(env, workspace.projectId, agentSession.id, 'interrupted', {
        actorType: 'system',
        actorId: null,
        reason: `Session sleeping: ${reason}`,
      })
      .catch((error) => {
        log.warn('session_sleep.acp_transition_failed', {
          workspaceId: workspace.id,
          agentSessionId: agentSession.id,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  if (workspace.nodeRuntime !== 'cf-container') {
    const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(workspace.nodeId));
    await (stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle)
      .scheduleWorkspaceDeletion(workspace.nodeId, workspace.id, workspace.userId)
      .catch((error) => {
        log.warn('session_sleep.workspace_deletion_schedule_failed', {
          workspaceId: workspace.id,
          nodeId: workspace.nodeId,
          error: error instanceof Error ? error.message : String(error),
        });
      });
  }

  await finishSleepingWorkspaceComputeCleanup(db, env, {
    workspaceId: workspace.id,
    taskId: workspace.taskId ?? null,
    warmNodeTimeoutMs: workspace.warmNodeTimeoutMs ?? null,
  });
  await markWorkspaceNodeWarmIfEmpty(db, env, {
    nodeId: workspace.nodeId,
    nodeRole: workspace.nodeRole ?? '',
    runtime: workspace.nodeRuntime,
    userId: workspace.userId,
    warmNodeTimeoutMs: workspace.warmNodeTimeoutMs ?? null,
  });

  log.info('session_sleep.completed', {
    workspaceId: workspace.id,
    chatSessionId: workspace.chatSessionId,
    nodeId: workspace.nodeId,
    runtime: workspace.nodeRuntime,
    expiresAt: verified.expiresAt,
    snapshotStatus: verified.status,
    snapshotDegradation: verified.degradation,
    reason: reason,
  });
  return {
    status: 'sleeping',
    workspaceId: workspace.id,
    chatSessionId: workspace.chatSessionId,
    snapshotExpiresAt: verified.expiresAt,
  };
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
