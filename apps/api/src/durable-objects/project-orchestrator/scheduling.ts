/**
 * ProjectOrchestrator — scheduling logic.
 *
 * Handles the core scheduling loop: check for task completions, route
 * handoff packets, recompute scheduler states, detect stalls, and
 * log decisions.
 */
import type { OrchestratorConfig } from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import * as projectDataService from '../../services/project-data';
import { recomputeMissionSchedulerStates } from '../../services/scheduler-state-sync';
import { getWorkflowConfig } from '../../services/workflow-config';
import {
  cleanupTerminalWorkflowWaits,
  reconcileWorkflowRun,
} from '../../services/workflow-reconcile';
import type { WorkflowRunRow } from '../../services/workflow-runs';
import { mapRows } from '../row-validation';
import { autoDispatchSchedulableTasks } from './auto-dispatch';
import { logDecision } from './decision-log';
import { buildHandoffContent, parseRoutableHandoff, type RoutableHandoff } from './handoff-content';
import { detectStalls, resolveActiveSessionIdsForTaskIds } from './stall-detection';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  status: string;
  scheduler_state: string | null;
  mission_id: string | null;
  updated_at: string;
}

/**
 * `SELECT mission_id, status, registered_at FROM orchestrator_missions ...`
 * shape used by the scheduling cycle. `status`/`registered_at` are NOT NULL
 * columns (see ./migrations.ts) but stay required (not optional) here — a
 * row missing them is malformed and should be skipped, not silently defaulted.
 */
const SchedulingMissionRowSchema = v.object({
  mission_id: v.string(),
  status: v.string(),
  registered_at: v.number(),
  workflow_registration_deadline: v.optional(v.nullable(v.number())),
});

// ── Scheduling Cycle ──────────────────────────────────────────────────────────

/**
 * Run one scheduling cycle for all active missions in this project.
 * Called from the DO alarm handler.
 */
export async function runSchedulingCycle(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  config: OrchestratorConfig
): Promise<void> {
  const now = Date.now();

  // Include completing rows left by the old lifecycle so they receive a
  // terminal cleanup instead of pinning an alarm chain forever.
  const missions = mapRows(
    sql
      .exec(
        `SELECT mission_id, status, registered_at, workflow_registration_deadline
           FROM orchestrator_missions
           WHERE status IN ('active', 'completing') ORDER BY last_checked_at, mission_id`
      )
      .toArray(),
    SchedulingMissionRowSchema,
    'orchestrator.scheduling_missions_list',
    'mission_id'
  );

  if (missions.length === 0) return;

  const workflowLaunchBudget = { remaining: 0 };
  let workflowBudgetLoaded = false;
  for (const mission of missions) {
    try {
      const workflow = await env.DATABASE.prepare(
        'SELECT * FROM missions WHERE id = ? AND project_id = ? AND workflow_plan_json IS NOT NULL'
      )
        .bind(mission.mission_id, projectId)
        .first<WorkflowRunRow>();
      if (workflow) {
        if (!workflowBudgetLoaded) {
          workflowLaunchBudget.remaining = (await getWorkflowConfig(env)).maxLaunchesPerCycle;
          workflowBudgetLoaded = true;
        }
        sql.exec(
          'UPDATE orchestrator_missions SET last_checked_at = ? WHERE mission_id = ?',
          now,
          mission.mission_id
        );
        await reconcileWorkflowRun(env, workflow, { launchBudget: workflowLaunchBudget });
        if (
          !['active', 'paused'].includes(workflow.status) &&
          (await cleanupTerminalWorkflowWaits(env, workflow, now))
        )
          cleanupMissionTracking(sql, mission.mission_id);
        if (workflowLaunchBudget.remaining <= 0) break;
        continue;
      }
      if (mission.workflow_registration_deadline != null) {
        // An uncommitted workflow may commit only BEFORE this same deadline
        // (enforced inside its D1 INSERT). It cannot appear after cleanup.
        if (now >= mission.workflow_registration_deadline)
          cleanupMissionTracking(sql, mission.mission_id);
        continue;
      }
      const status = mission.status ?? 'active';
      if (status === 'completing') {
        cleanupMissionTracking(sql, mission.mission_id);
        log.info('orchestrator.mission_terminal', {
          projectId,
          missionId: mission.mission_id,
          reason: 'completing_reconciled',
        });
        continue;
      }

      const registeredAt = mission.registered_at ?? now;
      if (now - registeredAt >= config.maxMissionLifetimeMs) {
        await terminalizeMission(
          sql,
          env,
          projectId,
          mission.mission_id,
          'completed',
          'max_mission_lifetime',
          now
        );
        continue;
      }

      await processMission(sql, env, projectId, mission.mission_id, config, now, registeredAt);
    } catch (err) {
      log.error('orchestrator.scheduling_cycle.mission_error', {
        projectId,
        missionId: mission.mission_id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Update last_checked_at
    sql.exec(
      'UPDATE orchestrator_missions SET last_checked_at = ? WHERE mission_id = ?',
      now,
      mission.mission_id
    );
  }
}

/**
 * Process a single mission: check completions, route handoffs, detect stalls.
 */
async function processMission(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  config: OrchestratorConfig,
  now: number,
  registeredAt: number
): Promise<void> {
  // 1. Fetch all tasks for this mission from D1
  const tasksResult = await env.DATABASE.prepare(
    `SELECT id, status, scheduler_state, mission_id, updated_at
     FROM tasks WHERE mission_id = ?`
  )
    .bind(missionId)
    .all<TaskRow>();

  const tasks = tasksResult.results ?? [];
  if (tasks.length === 0) {
    if (now - registeredAt >= config.zeroTaskGraceMs) {
      await terminalizeMission(
        sql,
        env,
        projectId,
        missionId,
        'completed',
        'zero_tasks_grace_expired',
        now
      );
    }
    return;
  }

  // 2. Recompute scheduler states
  await recomputeMissionSchedulerStates(env.DATABASE, missionId);

  // 3. Auto-dispatch schedulable tasks
  await autoDispatchSchedulableTasks(sql, env, projectId, missionId, config, now);

  // 5. Find newly completed tasks — check for handoff packets to route
  const completedTasks = tasks.filter((t) => t.status === 'completed');
  for (const task of completedTasks) {
    await routeHandoffsForTask(sql, env, projectId, missionId, task.id, tasks, now);
  }

  // 6. Detect stalled tasks
  await detectStalls(sql, env, projectId, missionId, tasks, config, now);

  // 7. Check if mission is complete (all tasks terminal)
  const allTerminal = tasks.every(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled'
  );
  if (allTerminal) {
    const anyFailed = tasks.some((t) => t.status === 'failed');
    const newMissionStatus = anyFailed ? 'failed' : 'completed';

    logDecision(
      sql,
      missionId,
      null,
      anyFailed ? 'skip' : 'dispatch', // 'dispatch' is semantic for "completed"
      `Mission ${anyFailed ? 'failed' : 'completed'}: all ${tasks.length} tasks are terminal`,
      now
    );

    await terminalizeMission(
      sql,
      env,
      projectId,
      missionId,
      newMissionStatus,
      'all_tasks_terminal',
      now
    );
  }
}

function cleanupMissionTracking(sql: SqlStorage, missionId: string): void {
  sql.exec('DELETE FROM scheduling_queue WHERE mission_id = ?', missionId);
  sql.exec('DELETE FROM orchestrator_missions WHERE mission_id = ?', missionId);
}

async function terminalizeMission(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  status: 'completed' | 'failed',
  reason: string,
  now: number
): Promise<void> {
  await env.DATABASE.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
    .bind(status, new Date(now).toISOString(), missionId)
    .run();

  cleanupMissionTracking(sql, missionId);
  log.info('orchestrator.mission_terminal', { projectId, missionId, status, reason });
}

// ── Auto-Dispatch ─────────────────────────────────────────────────────────────

// ── Handoff Routing ───────────────────────────────────────────────────────────

/**
 * Route handoff packets from a completed task to its dependent tasks.
 */
async function routeHandoffsForTask(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  completedTaskId: string,
  allTasks: TaskRow[],
  now: number
): Promise<void> {
  // Check if we already routed handoffs for this task in this mission
  const alreadyRouted = sql
    .exec(
      `SELECT 1 FROM decision_log WHERE mission_id = ? AND task_id = ? AND action = 'handoff_routed' LIMIT 1`,
      missionId,
      completedTaskId
    )
    .toArray();
  if (alreadyRouted.length > 0) return;

  // Get handoff packets from the completed task
  let handoffs: RoutableHandoff[];
  try {
    const rawHandoffs = await projectDataService.getHandoffPacketsForTask(
      env,
      projectId,
      completedTaskId
    );
    handoffs = rawHandoffs
      .map(parseRoutableHandoff)
      .filter((handoff): handoff is RoutableHandoff => handoff !== null);
  } catch {
    return; // No handoffs to route
  }
  if (!handoffs || handoffs.length === 0) return;

  // Find dependent tasks (tasks that depend on the completed task)
  const depsResult = await env.DATABASE.prepare(
    `SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ? AND task_id IN (
       SELECT id FROM tasks WHERE mission_id = ?
     )`
  )
    .bind(completedTaskId, missionId)
    .all<{ task_id: string }>();

  const dependentTaskIds = (depsResult.results ?? []).map((r) => r.task_id);
  if (dependentTaskIds.length === 0) return;

  const sessionResolutions = await resolveActiveSessionIdsForTaskIds(
    env,
    projectId,
    dependentTaskIds
  );
  let routeIncomplete = false;

  // Route each handoff to dependent tasks via durable messages
  for (const depTaskId of dependentTaskIds) {
    // Find the chat session for the dependent task (needed for mailbox targeting)
    const depTask = allTasks.find((t) => t.id === depTaskId);
    if (!depTask || depTask.status === 'completed' || depTask.status === 'cancelled') continue;

    const targetSessionId = sessionResolutions.get(depTaskId) ?? null;
    if (!targetSessionId) {
      const reason = 'No active chat session found for dependent task; handoff not enqueued';
      log.warn('orchestrator.handoff_target_session_missing', {
        projectId,
        missionId,
        fromTaskId: completedTaskId,
        toTaskId: depTaskId,
        reason,
      });
      logDecision(sql, missionId, depTaskId, 'skip', reason, now, {
        fromTaskId: completedTaskId,
        toTaskId: depTaskId,
        reason: 'missing_target_session',
      });
      routeIncomplete = true;
      continue;
    }

    for (const handoff of handoffs) {
      try {
        const content = buildHandoffContent(completedTaskId, handoff);
        await projectDataService.enqueueMailboxMessage(env, projectId, {
          targetSessionId,
          sourceTaskId: completedTaskId,
          senderType: 'orchestrator' as const,
          senderId: `orchestrator:${projectId}`,
          messageClass: 'deliver' as const,
          content,
          metadata: { handoffId: handoff.id, fromTaskId: completedTaskId },
        });
      } catch (err) {
        routeIncomplete = true;
        log.warn('orchestrator.handoff_route_failed', {
          projectId,
          missionId,
          fromTaskId: completedTaskId,
          toTaskId: depTaskId,
          handoffId: handoff.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  if (routeIncomplete) {
    logDecision(
      sql,
      missionId,
      completedTaskId,
      'retry',
      `Handoff routing deferred: one or more dependent task sessions were unavailable`,
      now,
      {
        handoffCount: handoffs.length,
        dependentTaskCount: dependentTaskIds.length,
        reason: 'handoff_route_incomplete',
      }
    );
    return;
  }

  logDecision(
    sql,
    missionId,
    completedTaskId,
    'handoff_routed',
    `Routed ${handoffs.length} handoff(s) to ${dependentTaskIds.length} dependent task(s)`,
    now
  );
}
