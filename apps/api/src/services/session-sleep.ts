import { and, desc, eq, inArray } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { parsePositiveInt } from '../lib/route-helpers';
import { ulid } from '../lib/ulid';
import { hibernateAgentSessionOnNode, stopWorkspaceOnNode } from './node-agent';
import * as projectDataService from './project-data';
import {
  beginSessionSnapshotStopping,
  claimSessionSnapshotSleep,
  deferSessionSnapshotStopping,
  ensureSessionSnapshotForSleep,
  failSessionSnapshotSleepBeforeTeardown,
  finalizeSessionSnapshotSleeping,
  getRestorableSessionSnapshot,
  getSessionSnapshotCaptureState,
  verifyRestorableSessionSnapshotArtifacts,
} from './session-snapshots';
import { markVmAgentContainerActiveWorkStarted, sleepVmAgentContainer } from './vm-agent-container';

type SnapshotResult = { status?: unknown; degradation?: unknown };

const DEFAULT_SESSION_SNAPSHOT_REQUEST_TIMEOUT_MS = 5 * 60 * 1000;
const DEFAULT_SESSION_SNAPSHOT_POLL_INTERVAL_MS = 1000;

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
