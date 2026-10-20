import { and, desc, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import { parsePositiveInt } from '../lib/route-helpers';
import { expectJsonRecord } from '../lib/runtime-validation';
import { attachWakeState } from '../routes/chat/wake-state';
import { resolveChatAgentState } from '../routes/chat-agent-state';
import { requireSessionWriter } from '../services/session-access';
import {
  classifySessionIdleness,
  getFreshHarnessWorkLeaseExpiry,
  parseHarnessWorkConfig,
} from '../services/session-idleness';
import { DEFAULT_SESSION_SLEEP_AFTER_MS } from '../services/session-snapshots';
import { authorizeProjectOperation } from './authorization';
import { diagnostic } from './operational-projections';
import type { OperationContext } from './types';

export async function operationalSession(
  ctx: OperationContext,
  projectId: string,
  sessionId: string
) {
  await authorizeProjectOperation(ctx, projectId);
  return requireSessionWriter(ctx.env, projectId, sessionId, ctx.actor.userId, {
    action: 'inspect operational evidence for this session',
  });
}

/** Persistence-only: neither node RPCs nor lifecycle mutations belong in this read. */
export async function chatStatus(ctx: OperationContext, projectId: string, sessionId: string) {
  const writer = await operationalSession(ctx, projectId, sessionId);
  const db = drizzle(ctx.env.DATABASE, { schema });
  const [task] = await db
    .select({
      id: schema.tasks.id,
      status: schema.tasks.status,
      executionStep: schema.tasks.executionStep,
      terminalReason: schema.tasks.terminalReason,
      completedAt: schema.tasks.completedAt,
      error: schema.tasks.errorMessage,
    })
    .from(schema.tasks)
    .where(
      and(
        eq(schema.tasks.projectId, projectId),
        eq(schema.tasks.userId, writer.ownerUserId),
        eq(schema.tasks.chatSessionId, sessionId)
      )
    )
    .orderBy(desc(schema.tasks.updatedAt), desc(schema.tasks.id))
    .limit(1);
  const [workspace] = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
      reservation: schema.workspaces.resolvedReservationJson,
      runtimeDeletionConfirmedAt: schema.workspaces.runtimeDeletionConfirmedAt,
      stopRuntimeConfirmedAt: schema.workspaces.stopRuntimeConfirmedAt,
      nodeStatus: schema.nodes.status,
      runtime: schema.nodes.runtime,
      error: schema.workspaces.errorMessage,
    })
    .from(schema.workspaces)
    .leftJoin(schema.nodes, eq(schema.nodes.id, schema.workspaces.nodeId))
    .where(
      and(
        eq(schema.workspaces.projectId, projectId),
        eq(schema.workspaces.userId, writer.ownerUserId),
        eq(schema.workspaces.chatSessionId, sessionId)
      )
    )
    .orderBy(desc(schema.workspaces.createdAt), desc(schema.workspaces.id))
    .limit(1);
  const resolved = await resolveChatAgentState(ctx.env, {
    projectId,
    sessionId,
    lookupFailureEvent: 'connector.status_runtime_lookup_failed',
    stateFailureEvent: 'connector.status_state_failed',
    includePlan: false,
  });
  const state = await attachWakeState(db, resolved.state, {
    projectId,
    sessionId,
    sessionStatus: writer.session.status,
  });
  // Plan persistence can create a raw session_state row with idle/default activity.
  // Only an attributed activity observation is evidence of a prompt transition.
  const reportedState = resolved.state?.activitySource ? resolved.state : null;
  const now = new Date();
  const harnessWorkConfig = parseHarnessWorkConfig(ctx.env);
  const freshWork = getFreshHarnessWorkLeaseExpiry(
    resolved.state,
    now,
    harnessWorkConfig.leaseMs,
    harnessWorkConfig.maxDurationMs
  );
  const classificationState =
    reportedState ??
    (freshWork ? { ...resolved.state, activity: undefined, activityAt: undefined } : null);
  // A wake placeholder is not runtime activity evidence. Classify only the original observation.
  const idleness = classifySessionIdleness({
    taskStatus: task?.status ?? null,
    taskCompletedAt: task?.completedAt,
    state: classificationState,
    now,
    idleAfterMs: parsePositiveInt(ctx.env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS),
    harnessWorkConfig,
    policy: 'prompt-turn-ended',
  });
  let reservation: Record<string, unknown> | null = null;
  try {
    const parsed: unknown = JSON.parse(workspace?.reservation ?? 'null');
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      const row = expectJsonRecord(parsed, 'connector.resource_reservation');
      reservation = Object.fromEntries(
        ['cpuMillis', 'memoryMb', 'diskMb']
          .filter((k) => typeof row[k] === 'number' && Number.isFinite(row[k]))
          .map((k) => [k, row[k]])
      );
    }
  } catch {
    /* Invalid persisted reservation is unknown, never raw JSON. */
  }
  return {
    projectId,
    chatSessionId: sessionId,
    agentSessionId: resolved.agentSessionId,
    workspaceId: workspace?.id ?? null,
    taskId: task?.id ?? null,
    sessionStatus: writer.session.status ?? 'unknown',
    task: task
      ? {
          id: task.id,
          status: task.status,
          executionStep: task.executionStep,
          terminalReason: task.terminalReason ? 'present' : null,
          completedAt: task.completedAt,
        }
      : null,
    runtime: {
      agentType: resolved.agentType,
      activity: reportedState?.activity ?? 'unknown',
      activityAt: reportedState?.activityAt ?? null,
      promptStartedAt: reportedState?.promptStartedAt ?? null,
      workState: resolved.state?.runtimeWorkState ?? 'unknown',
      workCount: resolved.state?.runtimeWorkCount ?? null,
      workUpdatedAt: resolved.state?.runtimeWorkUpdatedAt ?? null,
      workProgressAt: resolved.state?.runtimeWorkProgressAt ?? null,
      evidence: reportedState ? 'last_reported' : 'unknown',
      activitySource: reportedState?.activitySource ?? null,
      freshness: 'not_live_verified',
      idleness,
    },
    recovery: { status: state?.recoveryStatus ?? 'unknown', phase: state?.wakePhase ?? null },
    resources: {
      runtime: workspace?.runtime ?? 'unknown',
      workspaceStatus: workspace?.status ?? 'unknown',
      reservation,
      nodeStatus: workspace?.nodeStatus ?? 'unknown',
      nodeRelease: 'unknown',
      cleanup: {
        state: workspace?.runtimeDeletionConfirmedAt ? 'runtime_deletion_confirmed' : 'unknown',
        runtimeDeletionConfirmedAt: workspace?.runtimeDeletionConfirmedAt ?? null,
        stopRuntimeConfirmedAt: workspace?.stopRuntimeConfirmedAt ?? null,
        filesystemAndMetadataCleanup: 'unknown',
        nextRetryAt: null,
      },
    },
    diagnostics: [
      diagnostic(task?.error, 'TASK_ERROR'),
      diagnostic(workspace?.error, 'WORKSPACE_ERROR'),
      diagnostic(resolved.state?.statusError, 'RUNTIME_ERROR'),
      diagnostic(resolved.state?.lastStopReason, 'RUNTIME_STOP_REASON'),
    ].filter(Boolean),
    observedAt: Date.now(),
    evidence: 'persisted_snapshot_not_atomic',
  };
}
