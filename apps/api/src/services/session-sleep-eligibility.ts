import { and, desc, eq, inArray, isNull, or, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { parsePositiveInt } from '../lib/route-helpers';
import * as projectDataService from './project-data';
import { parseProviderLimitWait, providerLimitNeedsImmediateSleep } from './provider-limit-policy';
import {
  classifySessionIdleness,
  parseHarnessWorkConfig,
  type SessionIdlenessActivityState,
  type SessionIdlenessClassification,
  sessionWorkAnchor,
} from './session-idleness';
import { resolveSleepRequirement, type SleepRequirement } from './session-sleep-requirement';
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

/**
 * The gate every sleep teardown asks before its point of no return: has the agent handed
 * control back with nothing it started still in flight (`policy: 'prompt-turn-ended'`)?
 * It asks the SAFETY question only. Whoever reached the teardown already decided the
 * session should sleep: the sweep enforced the idle interval in its eligibility check,
 * and a person pressing Sleep on a session that just went idle must not wait for it.
 */
export function sleepTeardownSafetyGate(
  env: Env,
  task: { taskStatus: string | null; taskCompletedAt: string | null },
  requirement: SleepRequirement = 'normal'
): (state: SessionIdlenessActivityState | null) => SessionIdlenessClassification {
  if (requirement === 'required') return classifyRequiredSleepTurn;
  const idleAfterMs = parsePositiveInt(env.SESSION_SLEEP_AFTER_MS, DEFAULT_SESSION_SLEEP_AFTER_MS);
  const harnessWorkConfig = parseHarnessWorkConfig(env);
  return (state) =>
    classifySessionIdleness({
      taskStatus: task.taskStatus,
      taskCompletedAt: task.taskCompletedAt,
      state,
      now: new Date(),
      idleAfterMs,
      harnessWorkConfig,
      policy: 'prompt-turn-ended',
    });
}

/**
 * The gate for a REQUIRED sleep (`session-sleep-requirement.ts`), asked after
 * `endAgentTurnForRequiredSleep` has ended the turn. Only a running turn blocks it: a harness
 * lease, the idle interval, a completed task's drain and an unknown state do not, because a
 * required sleep must not fail (policy a3780107).
 */
export function classifyRequiredSleepTurn(
  state: SessionIdlenessActivityState | null
): SessionIdlenessClassification {
  const activity = state?.activity ?? null;
  // `recovering` is not a turn here: the required sleep has just cancelled the turn, and the
  // VM restarts the killed agent idle, reporting `recovering` while it does.
  if (activity === 'prompting') {
    return { idle: false, conclusive: true, reason: 'prompt_turn_active', activity };
  }
  return { idle: true, conclusive: true, reason: 'idle', activity };
}

/**
 * Did something between two reads invalidate the sleep? For a required sleep nothing here does:
 * the only thing that may abort it is a new prompt turn, and the required gate
 * (`classifyRequiredSleepTurn`) already refuses every read that shows one. Harness, work-clock
 * and `recovering` changes are expected while the cancelled agent restarts.
 */
export function sleepStateChanged(
  before: SessionIdlenessActivityState | null,
  after: SessionIdlenessActivityState | null,
  requirement: SleepRequirement
): boolean {
  if (requirement === 'required') return false;
  if (!before || !after) return before !== after;
  return idlenessStateChanged(before, after);
}

/**
 * Did the session do real work between two reads? Compares the work clock, never the
 * last-report clocks `activityAt` and `runtimeWorkUpdatedAt`: the VM agent re-reports an
 * open turn every minute, so comparing those aborted every sleep of a turn that never
 * returns. A fresh harness lease still blocks through the idleness gate itself.
 */
export function idlenessStateChanged(
  before: SessionIdlenessActivityState,
  after: SessionIdlenessActivityState
): boolean {
  return (
    after.activity !== before.activity ||
    sessionWorkAnchor(after) !== sessionWorkAnchor(before) ||
    after.runtimeWorkState !== before.runtimeWorkState ||
    after.runtimeWorkCount !== before.runtimeWorkCount ||
    after.runtimeWorkSource !== before.runtimeWorkSource ||
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
    /** The episode is the retry of a person's failed Sleep (`isPersonRequiredSleepEpisode`). */
    requiredByPerson?: boolean;
  },
  now = new Date()
): Promise<AutomaticSessionSleepEligibility> {
  const db = drizzle(env.DATABASE, { schema });
  const [workspace] = await db
    .select({
      projectId: schema.workspaces.projectId,
      chatSessionId: schema.workspaces.chatSessionId,
      taskStatus: schema.tasks.status,
      admissionState: schema.tasks.admissionState,
      providerLimitWaitJson: schema.tasks.providerLimitWaitJson,
      taskCompletedAt: sql<
        string | null
      >`COALESCE(${schema.tasks.completedAt}, ${schema.tasks.updatedAt})`,
      nodeCreatedAt: schema.nodes.createdAt,
      nodeRole: schema.nodes.nodeRole,
      nodeClass: schema.nodes.nodeClass,
      nodeAutoProvisioned: sql<number>`EXISTS (SELECT 1 FROM tasks auto_task
        WHERE auto_task.auto_provisioned_node_id = ${schema.workspaces.nodeId})`,
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
    .where(
      and(eq(schema.workspaces.id, input.workspaceId), eq(schema.workspaces.userId, input.userId))
    )
    .limit(1);
  if (!workspace?.projectId || !workspace.chatSessionId) {
    return { eligible: false, reason: 'workspace_metadata_missing' };
  }
  // A person's failed Sleep, or a node past its absolute lifetime plus the leeway: the claimed
  // sleep ends the turn itself (`sleepWorkspaceSession`), so nothing here may defer it.
  const requirement = await resolveSleepRequirement(env, workspace, now, {
    requestedByPerson: input.requiredByPerson === true,
  });
  if (requirement === 'required') return { eligible: true };
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
    // Only long known resets (or blocked/unknown waits) request immediate sleep.
    // Short resets retain the ordinary idle interval; safety gates always apply.
    // Past the node's absolute lifetime the session sleeps as soon as its turn ends.
    policy:
      requirement === 'deadline' ||
      (['provider_limit_waiting', 'provider_limit_blocked'].includes(
        workspace.admissionState ?? ''
      ) &&
        providerLimitNeedsImmediateSleep(
          parseProviderLimitWait(workspace.providerLimitWaitJson),
          now.getTime(),
          idleAfterMs
        ))
        ? 'prompt-turn-ended'
        : 'idle-interval-elapsed',
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
