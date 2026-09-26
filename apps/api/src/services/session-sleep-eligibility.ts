import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from './project-data';
import {
  classifySessionIdleness,
  parseHarnessWorkConfig,
  type SessionIdlenessActivityState,
  type SessionIdlenessClassification,
} from './session-idleness';
import {
  DEFAULT_SESSION_SLEEP_AFTER_MS,
  deferSessionSnapshotSleepBeforeClaim,
} from './session-snapshots';

export interface AutomaticSessionSleepEligibility {
  eligible: boolean;
  reason?: string;
  retryAt?: string;
}

export function sessionSleepDeferralReason(
  classification: SessionIdlenessClassification,
  state: SessionIdlenessActivityState | null
): string {
  switch (classification.reason) {
    case 'runtime_work_lease_active':
      return 'Harness-owned background work is active';
    case 'idle_interval_pending':
      return 'Workspace idle interval has not elapsed';
    default:
      return `Workspace agent is not idle (${state?.activity ?? 'unknown'})`;
  }
}

export function idlenessStateChanged(
  before: SessionIdlenessActivityState,
  after: SessionIdlenessActivityState
): boolean {
  return (
    after.activity !== before.activity ||
    after.activityAt !== before.activityAt ||
    after.runtimeWorkState !== before.runtimeWorkState ||
    after.runtimeWorkCount !== before.runtimeWorkCount ||
    after.runtimeWorkSource !== before.runtimeWorkSource ||
    after.runtimeWorkUpdatedAt !== before.runtimeWorkUpdatedAt ||
    after.runtimeWorkProgressAt !== before.runtimeWorkProgressAt
  );
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
      taskCompletedAt: sql<
        string | null
      >`COALESCE(${schema.tasks.completedAt}, ${schema.tasks.updatedAt})`,
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
  const idleAfterMs = parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  const idleness = classifySessionIdleness({
    taskStatus: workspace.taskStatus,
    taskCompletedAt: workspace.taskCompletedAt,
    state,
    now,
    idleAfterMs,
    harnessWorkConfig: parseHarnessWorkConfig(env),
    // The unattended scheduler is the only caller that also waits out the idle
    // interval before reclaiming a session on its own initiative.
    policy: 'idle-interval-elapsed',
  });
  if (idleness.idle) {
    return { eligible: true };
  }

  const reason = sessionSleepDeferralReason(idleness, state);
  const retryAt = idleness.retryAt;

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
