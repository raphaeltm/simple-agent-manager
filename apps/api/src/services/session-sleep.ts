import { and, desc, eq, inArray, isNull, or } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { stopComputeTracking } from './compute-usage';
import { hibernateAgentSessionOnNode, stopWorkspaceOnNode } from './node-agent';
import * as projectDataService from './project-data';
import {
  beginSessionSnapshotStopping,
  claimSessionSnapshotSleep,
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  deferSessionSnapshotSleepBeforeClaim,
  deferSessionSnapshotStopping,
  ensureSessionSnapshotForSleep,
  failSessionSnapshotSleepBeforeTeardown,
  finalizeSessionSnapshotSleeping,
  getRestorableSessionSnapshot,
  getSessionSnapshotCaptureState,
  scheduleSessionSnapshotSleep,
  verifyRestorableSessionSnapshotArtifacts,
} from './session-snapshots';
import { cleanupTaskRun } from './task-runner';
import { markVmAgentContainerActiveWorkStarted, sleepVmAgentContainer } from './vm-agent-container';

type SnapshotResult = { status?: unknown; degradation?: unknown };

const DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_SNAPSHOT_POLL_INTERVAL_MS = 1000;

async function finishSleepingWorkspaceComputeCleanup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  input: {
    workspaceId: string;
    taskId: string | null;
    warmNodeTimeoutMs: number | null;
  }
): Promise<void> {
  await stopComputeTracking(db, input.workspaceId).catch((error) => {
    log.warn('session_sleep.compute_tracking_stop_failed', {
      workspaceId: input.workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
  });
  if (input.taskId) {
    await cleanupTaskRun(input.taskId, env, input.warmNodeTimeoutMs).catch((error) => {
      log.warn('session_sleep.task_cleanup_failed', {
        workspaceId: input.workspaceId,
        taskId: input.taskId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }
}

async function markWorkspaceNodeWarmIfEmpty(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  input: {
    nodeId: string;
    nodeRole: string;
    runtime: string;
    userId: string;
    warmNodeTimeoutMs: number | null;
  }
): Promise<void> {
  if (input.runtime === 'cf-container' || input.nodeRole !== 'workspace') return;
  try {
    // Generic task cleanup may already have transitioned the node using the
    // project's warm-retention override. In that case, do not reset its timer.
    const [node] = await db
      .select({ status: schema.nodes.status, warmSince: schema.nodes.warmSince })
      .from(schema.nodes)
      .where(eq(schema.nodes.id, input.nodeId))
      .limit(1);
    if (!node || node.warmSince || ['stopped', 'deleted'].includes(node.status)) return;

    const active = await db
      .select({ id: schema.workspaces.id })
      .from(schema.workspaces)
      .where(
        and(
          eq(schema.workspaces.nodeId, input.nodeId),
          inArray(schema.workspaces.status, ['running', 'creating', 'recovery'])
        )
      )
      .limit(1);
    if (active.length > 0) return;

    const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(input.nodeId));
    await (stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle).markIdle(
      input.nodeId,
      input.userId,
      input.warmNodeTimeoutMs
    );
  } catch (error) {
    log.warn('session_sleep.node_warm_transition_failed', {
      nodeId: input.nodeId,
      userId: input.userId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

async function waitForFinalSessionSnapshot(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  input: {
    nodeId: string;
    workspaceId: string;
    agentSessionId: string;
    chatSessionId: string;
    runtime: string;
    agentType?: string;
    userId: string;
  }
): Promise<void> {
  const timeoutMs = parsePositiveInt(
    env.SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS,
    DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS
  );
  const pollIntervalMs = parsePositiveInt(
    env.SESSION_SNAPSHOT_POLL_INTERVAL_MS,
    DEFAULT_SESSION_SNAPSHOT_POLL_INTERVAL_MS
  );
  const deadline = Date.now() + timeoutMs;
  let baselineGeneration: string | null = null;

  while (Date.now() < deadline) {
    const current = await getSessionSnapshotCaptureState(db, input.chatSessionId);
    if (input.runtime === 'cf-container') {
      await markVmAgentContainerActiveWorkStarted(env, input.nodeId, {
        workspaceId: input.workspaceId,
        agentSessionId: input.agentSessionId,
        reason: 'session_snapshot_final_capture',
      });
    }
    const result = (await hibernateAgentSessionOnNode(
      input.nodeId,
      input.workspaceId,
      input.agentSessionId,
      env,
      input.userId,
      {
        chatSessionId: input.chatSessionId,
        runtime: input.runtime,
        agentType: input.agentType,
        background: true,
      }
    )) as SnapshotResult & { accepted?: unknown };
    if (result.status !== 'pending') {
      throw new Error(`Workspace snapshot request was not accepted (${String(result.status)})`);
    }
    if (result.accepted === true) {
      baselineGeneration = current?.snapshotGeneration ?? null;
      break;
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }

  while (Date.now() < deadline) {
    const current = await getSessionSnapshotCaptureState(db, input.chatSessionId);
    if (
      current &&
      !current.captureGeneration &&
      current.snapshotGeneration !== baselineGeneration
    ) {
      if (current.status === 'available' && current.degradation === 'none') return;
      throw new Error(
        `Workspace snapshot is not complete (${current.status}/${current.degradation})`
      );
    }
    await new Promise((resolve) => setTimeout(resolve, pollIntervalMs));
  }
  throw new Error(`Workspace snapshot did not complete within ${timeoutMs}ms`);
}

export interface SleepWorkspaceSessionResult {
  status: 'sleeping';
  workspaceId: string;
  chatSessionId: string;
  snapshotExpiresAt: string;
}

/**
 * Persist a sleep intent without touching the live runtime. Terminal completion
 * uses a zero delay while it is still inside the final ACP prompt; the scheduled
 * sweep performs the snapshot and teardown after ProjectData reports idle.
 */
export async function queueWorkspaceSessionSleep(
  env: Env,
  input: { workspaceId: string; userId: string; reason: string; sleepAfterMs?: number }
): Promise<void> {
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      userId: schema.workspaces.userId,
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      nodeId: schema.workspaces.nodeId,
      nodeRuntime: schema.nodes.runtime,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(
      and(eq(schema.workspaces.id, input.workspaceId), eq(schema.workspaces.userId, input.userId))
    )
    .limit(1);
  if (
    !workspace?.projectId ||
    !workspace.chatSessionId ||
    !workspace.nodeId ||
    !workspace.nodeRuntime
  ) {
    throw new Error('Workspace is missing persistent-session ownership metadata');
  }
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspace.id),
        inArray(schema.agentSessions.status, ['running', 'recovery', 'sleeping'])
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);
  if (!agentSession) throw new Error('Workspace has no resumable agent session');

  await ensureSessionSnapshotForSleep(db, env, {
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    projectId: workspace.projectId,
    userId: workspace.userId,
    chatSessionId: workspace.chatSessionId,
    agentSessionId: agentSession.id,
    runtime: workspace.nodeRuntime,
  });
  const sleepAfterMs =
    input.sleepAfterMs ??
    parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  await scheduleSessionSnapshotSleep(db, env, workspace.chatSessionId, new Date(), {
    sleepAfterMs,
    allowIncomplete: true,
    resetAttempts: false,
  });
  log.info('session_sleep.queued', {
    workspaceId: workspace.id,
    chatSessionId: workspace.chatSessionId,
    reason: input.reason,
    sleepAfterMs,
  });
}

export interface AutomaticSessionSleepEligibility {
  eligible: boolean;
  reason?: string;
  retryAt?: string;
}

/**
 * Check the authoritative ProjectData work-activity clock before the sweep
 * consumes a sleep attempt. Node/ACP heartbeats are deliberately absent: they
 * establish runtime liveness, not whether the user is actively working.
 */
export async function checkAutomaticSessionSleepEligibility(
  env: Env,
  input: {
    workspaceId: string;
    userId: string;
    sleepStatus?: string | null;
    sleepClaimId?: string | null;
  },
  now = new Date()
): Promise<AutomaticSessionSleepEligibility> {
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      taskStatus: schema.tasks.status,
    })
    .from(schema.workspaces)
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
    .where(
      and(eq(schema.workspaces.id, input.workspaceId), eq(schema.workspaces.userId, input.userId))
    )
    .limit(1);
  if (!workspace?.projectId || !workspace.chatSessionId) {
    return { eligible: false, reason: 'workspace_metadata_missing' };
  }
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, input.workspaceId),
        inArray(schema.agentSessions.status, ['running', 'recovery', 'sleeping'])
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);
  const state = agentSession
    ? await projectDataService
        .getSessionState(env, workspace.projectId, agentSession.id)
        .catch(() => null)
    : null;
  let reason: string;
  let retryAt: Date | undefined;
  if (!state || state.activity !== 'idle') {
    reason = `Workspace agent is not idle (${state?.activity ?? 'unknown'})`;
  } else if (workspace.taskStatus !== 'completed') {
    const idleAfterMs = parsePositiveInt(
      env.SESSION_SLEEP_AFTER_MS,
      DEFAULT_SESSION_SLEEP_AFTER_MS
    );
    const idleEligibleAt = state.activityAt ? state.activityAt + idleAfterMs : 0;
    if (!idleEligibleAt || idleEligibleAt > now.getTime()) {
      reason = 'Workspace idle interval has not elapsed';
      retryAt = idleEligibleAt ? new Date(idleEligibleAt) : undefined;
    } else {
      return { eligible: true };
    }
  } else {
    return { eligible: true };
  }

  await deferSessionSnapshotSleepBeforeClaim(
    db,
    env,
    workspace.chatSessionId,
    reason,
    retryAt,
    now,
    input.sleepStatus === 'preparing'
      ? { expectedPreparingClaimId: input.sleepClaimId ?? null }
      : undefined
  );
  return { eligible: false, reason, retryAt: retryAt?.toISOString() };
}

export async function sleepWorkspaceSession(
  env: Env,
  input: { workspaceId: string; userId: string; reason: string; sleepClaimId?: string }
): Promise<SleepWorkspaceSessionResult> {
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
    .where(
      and(eq(schema.workspaces.id, input.workspaceId), eq(schema.workspaces.userId, input.userId))
    )
    .limit(1);
  if (
    !workspace?.projectId ||
    !workspace.chatSessionId ||
    !workspace.nodeId ||
    !workspace.nodeRuntime
  ) {
    throw new Error('Workspace is missing persistent-session ownership metadata');
  }

  let snapshot = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
  if (
    workspace.status === 'sleeping' &&
    snapshot?.status === 'available' &&
    snapshot.degradation === 'none' &&
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
      const stateBefore = await projectDataService.getSessionState(
        env,
        workspace.projectId,
        agentSession.id
      );
      if (!stateBefore || stateBefore.activity !== 'idle') {
        throw new Error(`Workspace agent is not idle (${stateBefore?.activity ?? 'unknown'})`);
      }

      await waitForFinalSessionSnapshot(db, env, {
        nodeId: workspace.nodeId,
        workspaceId: workspace.id,
        agentSessionId: agentSession.id,
        chatSessionId: workspace.chatSessionId,
        runtime: workspace.nodeRuntime,
        agentType: agentSession.agentType ?? undefined,
        userId: workspace.userId,
      });

      verified = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
      if (verified?.status !== 'available' || verified.degradation !== 'none') {
        throw new Error('Workspace snapshot completion was not durably verified');
      }
      const stateAfter = await projectDataService.getSessionState(
        env,
        workspace.projectId,
        agentSession.id
      );
      if (
        !stateAfter ||
        stateAfter.activity !== 'idle' ||
        stateAfter.activityAt !== stateBefore.activityAt
      ) {
        throw new Error('Workspace activity changed while the final snapshot was captured');
      }
      if (!(await verifyRestorableSessionSnapshotArtifacts(env, verified))) {
        throw new Error('Workspace snapshot artifacts failed durable R2 verification');
      }
      if (!(await beginSessionSnapshotStopping(db, workspace.chatSessionId, claimId))) {
        throw new Error('Workspace sleep claim was cancelled before teardown');
      }
      pointOfNoReturn = true;
    }

    const chatSession = await projectDataService.getSession(
      env,
      workspace.projectId,
      workspace.chatSessionId
    );
    if (!chatSession) throw new Error('ProjectData chat session is missing');
    const chatStatus = typeof chatSession.status === 'string' ? chatSession.status : null;
    if (chatStatus !== 'sleeping') {
      const slept = await projectDataService.sleepSession(
        env,
        workspace.projectId,
        workspace.chatSessionId
      );
      if (!slept) {
        const repaired = await projectDataService.getSession(
          env,
          workspace.projectId,
          workspace.chatSessionId
        );
        if (repaired?.status !== 'sleeping') {
          throw new Error('ProjectData refused the durable sleeping transition');
        }
      }
    }

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
    const finalized = await finalizeSessionSnapshotSleeping(
      db,
      env,
      workspace.chatSessionId,
      claimId
    );
    if (!finalized) {
      snapshot = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
      if (!snapshot?.sleepingAt || snapshot.sleepStatus !== 'sleeping') {
        throw new Error('Verified snapshot lost availability before sleep commit');
      }
    }
    verified = await getRestorableSessionSnapshot(db, workspace.chatSessionId);
    if (!verified?.sleepingAt || verified.sleepStatus !== 'sleeping') {
      throw new Error('Workspace sleep finalization was not durably verified');
    }
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

  const acpSession = await projectDataService
    .getAcpSession(env, workspace.projectId, agentSession.id)
    .catch(() => null);
  if (acpSession?.status === 'running') {
    await projectDataService
      .transitionAcpSession(env, workspace.projectId, agentSession.id, 'interrupted', {
        actorType: 'system',
        actorId: null,
        reason: `Session sleeping: ${input.reason}`,
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
    reason: input.reason,
  });
  return {
    status: 'sleeping',
    workspaceId: workspace.id,
    chatSessionId: workspace.chatSessionId,
    snapshotExpiresAt: verified.expiresAt,
  };
}
