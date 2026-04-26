/**
 * ProjectOrchestrator — scheduling logic.
 *
 * Handles the core scheduling loop: check for task completions, route
 * handoff packets, recompute scheduler states, detect stalls, and
 * log decisions.
 */
import type { DecisionAction } from '@simple-agent-manager/shared';
import type { OrchestratorConfig } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import * as projectDataService from '../../services/project-data';
import { recomputeMissionSchedulerStates } from '../../services/scheduler-state-sync';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  status: string;
  scheduler_state: string | null;
  mission_id: string | null;
  updated_at: string;
}

// ── Scheduling Cycle ──────────────────────────────────────────────────────────

/**
 * Run one scheduling cycle for all active missions in this project.
 * Called from the DO alarm handler.
 */
export async function runSchedulingCycle(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  config: OrchestratorConfig,
): Promise<void> {
  const now = Date.now();

  // Load active missions (raw snake_case from SQLite)
  const missions = sql.exec(
    `SELECT mission_id FROM orchestrator_missions WHERE status = 'active'`,
  ).toArray() as unknown as Array<{ mission_id: string }>;

  if (missions.length === 0) return;

  for (const mission of missions) {
    try {
      await processMission(sql, env, projectId, mission.mission_id, config, now);
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
      now, mission.mission_id,
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
): Promise<void> {
  // 1. Fetch all tasks for this mission from D1
  const tasksResult = await env.DATABASE.prepare(
    `SELECT id, status, scheduler_state, mission_id, updated_at
     FROM tasks WHERE mission_id = ?`,
  ).bind(missionId).all<TaskRow>();

  const tasks = tasksResult.results ?? [];
  if (tasks.length === 0) return;

  // 2. Recompute scheduler states
  await recomputeMissionSchedulerStates(env.DATABASE, missionId);

  // 3. Find newly completed tasks — check for handoff packets to route
  const completedTasks = tasks.filter((t) => t.status === 'completed');
  for (const task of completedTasks) {
    await routeHandoffsForTask(sql, env, projectId, missionId, task.id, tasks, now);
  }

  // 4. Detect stalled tasks
  await detectStalls(sql, env, projectId, missionId, tasks, config, now);

  // 5. Check if mission is complete (all tasks terminal)
  const allTerminal = tasks.every(
    (t) => t.status === 'completed' || t.status === 'failed' || t.status === 'cancelled',
  );
  if (allTerminal) {
    const anyFailed = tasks.some((t) => t.status === 'failed');
    const newMissionStatus = anyFailed ? 'failed' : 'completed';

    // Update D1 mission status
    await env.DATABASE.prepare(
      'UPDATE missions SET status = ?, updated_at = ? WHERE id = ?',
    ).bind(newMissionStatus, new Date().toISOString(), missionId).run();

    // Remove from orchestrator tracking
    sql.exec(
      `UPDATE orchestrator_missions SET status = 'completing' WHERE mission_id = ?`,
      missionId,
    );

    logDecision(sql, missionId, null, anyFailed ? 'skip' : 'dispatch', // 'dispatch' is semantic for "completed"
      `Mission ${anyFailed ? 'failed' : 'completed'}: all ${tasks.length} tasks are terminal`, now);

    log.info('orchestrator.mission_completed', { projectId, missionId, status: newMissionStatus });
  }
}

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
  now: number,
): Promise<void> {
  // Check if we already routed handoffs for this task
  const alreadyRouted = sql.exec(
    `SELECT 1 FROM decision_log WHERE task_id = ? AND action = 'handoff_routed' LIMIT 1`,
    completedTaskId,
  ).toArray();
  if (alreadyRouted.length > 0) return;

  // Get handoff packets from the completed task
  let handoffs;
  try {
    handoffs = await projectDataService.getHandoffPacketsForTask(env, projectId, completedTaskId);
  } catch {
    return; // No handoffs to route
  }
  if (!handoffs || handoffs.length === 0) return;

  // Find dependent tasks (tasks that depend on the completed task)
  const depsResult = await env.DATABASE.prepare(
    `SELECT task_id FROM task_dependencies WHERE depends_on_task_id = ? AND task_id IN (
       SELECT id FROM tasks WHERE mission_id = ?
     )`,
  ).bind(completedTaskId, missionId).all<{ task_id: string }>();

  const dependentTaskIds = (depsResult.results ?? []).map((r) => r.task_id);
  if (dependentTaskIds.length === 0) return;

  // Route each handoff to dependent tasks via durable messages
  for (const depTaskId of dependentTaskIds) {
    // Find the chat session for the dependent task (needed for mailbox targeting)
    const depTask = allTasks.find((t) => t.id === depTaskId);
    if (!depTask || depTask.status === 'completed' || depTask.status === 'cancelled') continue;

    for (const handoff of handoffs) {
      try {
        const content = buildHandoffContent(completedTaskId, handoff);
        await projectDataService.enqueueMailboxMessage(env, projectId, {
          targetSessionId: depTaskId, // Use task ID as target — resolved to session at delivery time
          sourceTaskId: completedTaskId,
          senderType: 'orchestrator' as const,
          senderId: `orchestrator:${projectId}`,
          messageClass: 'deliver' as const,
          content,
          metadata: { handoffId: handoff.id, fromTaskId: completedTaskId },
        });
      } catch (err) {
        log.warn('orchestrator.handoff_route_failed', {
          projectId, missionId, fromTaskId: completedTaskId,
          toTaskId: depTaskId, handoffId: handoff.id,
          error: err instanceof Error ? err.message : String(err),
        });
      }
    }
  }

  logDecision(sql, missionId, completedTaskId, 'handoff_routed',
    `Routed ${handoffs.length} handoff(s) to ${dependentTaskIds.length} dependent task(s)`, now);
}

/** Build a readable content string from a handoff packet for durable message delivery. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
function buildHandoffContent(fromTaskId: string, handoff: any): string {
  const parts: string[] = [`Handoff from task ${fromTaskId}:`, '', `**Summary:** ${handoff.summary}`];
  if (handoff.facts?.length) {
    const facts = (handoff.facts as Array<string | Record<string, string>>)
      .map((f) => `- ${typeof f === 'string' ? f : f.fact}`)
      .join('\n');
    parts.push('', `**Key Facts:**\n${facts}`);
  }
  if (handoff.openQuestions?.length) {
    const qs = (handoff.openQuestions as string[]).map((q) => `- ${q}`).join('\n');
    parts.push('', `**Open Questions:**\n${qs}`);
  }
  if (handoff.suggestedActions?.length) {
    const acts = (handoff.suggestedActions as string[]).map((a) => `- ${a}`).join('\n');
    parts.push('', `**Suggested Actions:**\n${acts}`);
  }
  return parts.join('\n');
}

// ── Stall Detection ───────────────────────────────────────────────────────────

/**
 * Detect tasks that have been running without progress for too long.
 */
async function detectStalls(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  tasks: TaskRow[],
  config: OrchestratorConfig,
  now: number,
): Promise<void> {
  const stallThreshold = now - config.stallTimeoutMs;

  const runningTasks = tasks.filter(
    (t) => t.status === 'running' || t.status === 'delegated',
  );

  for (const task of runningTasks) {
    const updatedAt = new Date(task.updated_at).getTime();
    if (updatedAt > stallThreshold) continue;

    // Check if we already sent a stall interrupt recently
    const recentStall = sql.exec(
      `SELECT 1 FROM decision_log
       WHERE task_id = ? AND action = 'stall_detected'
       AND created_at > ?
       LIMIT 1`,
      task.id, stallThreshold,
    ).toArray();
    if (recentStall.length > 0) continue;

    // Send interrupt message to the stalled task
    try {
      await projectDataService.enqueueMailboxMessage(env, projectId, {
        targetSessionId: task.id,
        sourceTaskId: null,
        senderType: 'orchestrator' as const,
        senderId: `orchestrator:${projectId}`,
        messageClass: 'interrupt' as const,
        content: `[Orchestrator] This task has not reported progress for ${Math.round(config.stallTimeoutMs / 60000)} minutes. ` +
          `Please provide a status update. If you are blocked, update your task status or request human input.`,
        metadata: { reason: 'stall_detection', stallDurationMs: now - updatedAt },
      });

      logDecision(sql, missionId, task.id, 'stall_detected',
        `Task stalled for ${Math.round((now - updatedAt) / 60000)}min — interrupt sent`, now);

      log.info('orchestrator.stall_detected', {
        projectId, missionId, taskId: task.id,
        stallDurationMs: now - updatedAt,
      });
    } catch (err) {
      log.warn('orchestrator.stall_interrupt_failed', {
        projectId, missionId, taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
}

// ── Decision Log ──────────────────────────────────────────────────────────────

export function logDecision(
  sql: SqlStorage,
  missionId: string,
  taskId: string | null,
  action: DecisionAction,
  reason: string,
  now: number,
  metadata?: Record<string, unknown>,
): void {
  sql.exec(
    `INSERT INTO decision_log (id, mission_id, task_id, action, reason, metadata, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ulid(), missionId, taskId, action, reason,
    metadata ? JSON.stringify(metadata) : null,
    now,
  );
}

/**
 * Prune old decision log entries beyond the configured max.
 */
export function pruneDecisionLog(sql: SqlStorage, maxEntries: number): void {
  sql.exec(
    `DELETE FROM decision_log WHERE id NOT IN (
       SELECT id FROM decision_log ORDER BY created_at DESC LIMIT ?
     )`,
    maxEntries,
  );
}
