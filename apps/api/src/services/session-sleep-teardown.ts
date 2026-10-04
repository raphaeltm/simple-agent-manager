/**
 * The teardown half of a session sleep: release the live runtime once a sleep
 * claim has crossed its point of no return (`stopping`), and the cleanup that
 * follows. Shared by the full-snapshot sleep (`session-sleep-execution.ts`) and
 * the bounded fallback sleep (`session-sleep-fallback.ts`) so both release a
 * workspace through the same idempotent lifecycle. Split out of
 * `session-sleep-execution.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { log } from '../lib/logger';
import { stopWorkspaceOnNode } from './node-agent';
import * as projectDataService from './project-data';
import {
  finishSleepingWorkspaceComputeCleanup,
  markWorkspaceNodeWarmIfEmpty,
} from './session-sleep-cleanup';
import {
  finalizeSessionSnapshotSleeping,
  getRestorableSessionSnapshot,
  isSessionSnapshotSleepReleasable,
} from './session-snapshots';
import { sleepVmAgentContainer } from './vm-agent-container';

export interface SleepWorkspaceSessionResult {
  status: 'sleeping';
  workspaceId: string;
  chatSessionId: string;
  snapshotExpiresAt: string;
}

export async function loadSleepWorkspace(env: Env, workspaceId: string, userId: string) {
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

export type SleepWorkspace = Awaited<ReturnType<typeof loadSleepWorkspace>>;

/** The workspace's latest agent session that a sleep can snapshot and stop. */
export async function loadResumableAgentSession(
  db: ReturnType<typeof drizzle<typeof schema>>,
  workspaceId: string
): Promise<{ id: string; agentType: string | null }> {
  const [agentSession] = await db
    .select({ id: schema.agentSessions.id, agentType: schema.agentSessions.agentType })
    .from(schema.agentSessions)
    .where(
      and(
        eq(schema.agentSessions.workspaceId, workspaceId),
        inArray(schema.agentSessions.status, ['running', 'recovery', 'sleeping'])
      )
    )
    .orderBy(desc(schema.agentSessions.createdAt))
    .limit(1);
  if (!agentSession) {
    throw new Error('Workspace has no resumable agent session');
  }
  return agentSession;
}

export async function scheduleSleepingWorkspaceDeletion(
  env: Env,
  workspace: SleepWorkspace,
  logEvent: string
): Promise<void> {
  if (workspace.nodeRuntime === 'cf-container') return;
  const stub = env.NODE_LIFECYCLE.get(env.NODE_LIFECYCLE.idFromName(workspace.nodeId));
  await (stub as unknown as import('../durable-objects/node-lifecycle').NodeLifecycle)
    .scheduleWorkspaceDeletion(workspace.nodeId, workspace.id, workspace.userId)
    .catch((error) => {
      log.warn(logEvent, {
        workspaceId: workspace.id,
        nodeId: workspace.nodeId,
        error: error instanceof Error ? error.message : String(error),
      });
    });
}

export async function finishSleepComputeCleanup(
  db: ReturnType<typeof drizzle<typeof schema>>,
  env: Env,
  workspace: SleepWorkspace
): Promise<void> {
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
}

export async function ensureProjectDataSleeping(
  env: Env,
  workspace: SleepWorkspace
): Promise<void> {
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

export async function completeSleepTeardown(
  env: Env,
  workspace: SleepWorkspace,
  agentSession: { id: string },
  claimId: string,
  verified: Awaited<ReturnType<typeof getRestorableSessionSnapshot>>,
  options: { fallback?: boolean } = {}
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
  const sleepWarning = options.fallback
    ? `Workspace slept through the bounded sleep fallback (transcript and Git recovery point, snapshot ${verified?.status ?? 'unknown'}/${verified?.degradation ?? 'unknown'})`
    : verified?.status === 'degraded'
      ? `Workspace slept with degraded snapshot (${verified.degradation})`
      : null;
  const finalized = await finalizeSessionSnapshotSleeping(
    db,
    env,
    workspace.chatSessionId,
    claimId,
    new Date(),
    {
      sleepWarning,
      expectedGeneration: verified?.snapshotGeneration ?? undefined,
      fallback: options.fallback ?? false,
    }
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

export async function finishAlreadySleeping(
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
    await scheduleSleepingWorkspaceDeletion(
      env,
      workspace,
      'session_sleep.workspace_deletion_reschedule_failed'
    );
    await finishSleepComputeCleanup(db, env, workspace);
    return {
      status: 'sleeping',
      workspaceId: workspace.id,
      chatSessionId: workspace.chatSessionId,
      snapshotExpiresAt: snapshot.expiresAt,
    };
  }
  return null;
}

export async function finishSleepCleanup(
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

  await scheduleSleepingWorkspaceDeletion(
    env,
    workspace,
    'session_sleep.workspace_deletion_schedule_failed'
  );
  await finishSleepComputeCleanup(db, env, workspace);

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
