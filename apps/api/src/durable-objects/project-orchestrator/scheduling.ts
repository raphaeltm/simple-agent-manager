/**
 * ProjectOrchestrator — scheduling logic.
 *
 * Handles the core scheduling loop: check for task completions, route
 * handoff packets, recompute scheduler states, detect stalls, and
 * log decisions.
 */
import type { DecisionAction } from '@simple-agent-manager/shared';
import type { OrchestratorConfig } from '@simple-agent-manager/shared';
import type { CredentialProvider, VMLocation, VMSize, WorkspaceProfile } from '@simple-agent-manager/shared';
import {
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  getDefaultLocationForProvider,
  isValidProvider,
} from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import * as projectDataService from '../../services/project-data';
import { recomputeMissionSchedulerStates } from '../../services/scheduler-state-sync';
import { startTaskRunnerDO } from '../../services/task-runner-do';

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

// ── Auto-Dispatch ─────────────────────────────────────────────────────────────

interface DispatchableTaskRow {
  id: string;
  title: string;
  description: string | null;
  user_id: string;
  project_id: string;
  output_branch: string | null;
  dispatch_depth: number;
  priority: number;
}

/**
 * Find schedulable tasks and auto-dispatch them via startTaskRunnerDO.
 * Respects concurrency limits from mission budget_config and per-cycle max.
 */
async function autoDispatchSchedulableTasks(
  sql: SqlStorage,
  env: Env,
  projectId: string,
  missionId: string,
  config: OrchestratorConfig,
  now: number,
): Promise<void> {
  // Re-read task states from D1 (fresh after recompute)
  const schedulableResult = await env.DATABASE.prepare(
    `SELECT id, title, description, user_id, project_id, output_branch, dispatch_depth, priority
     FROM tasks
     WHERE mission_id = ? AND scheduler_state = 'schedulable' AND status = 'queued'
     ORDER BY priority DESC, created_at ASC
     LIMIT ?`,
  ).bind(missionId, config.maxDispatchesPerCycle).all<DispatchableTaskRow>();

  const schedulable = schedulableResult.results ?? [];
  if (schedulable.length === 0) return;

  // Check concurrency limit: count currently active tasks in this mission
  const activeCountResult = await env.DATABASE.prepare(
    `SELECT COUNT(*) as cnt FROM tasks
     WHERE mission_id = ? AND status IN ('in_progress', 'delegated', 'provisioning', 'running')`,
  ).bind(missionId).first<{ cnt: number }>();

  const activeCount = activeCountResult?.cnt ?? 0;

  // Resolve max active tasks from mission budget_config
  const missionRow = await env.DATABASE.prepare(
    'SELECT budget_config FROM missions WHERE id = ?',
  ).bind(missionId).first<{ budget_config: string | null }>();

  let maxActive = config.maxActiveTasksPerMission;
  if (missionRow?.budget_config) {
    try {
      const budget = JSON.parse(missionRow.budget_config) as { maxActiveTasks?: number };
      if (budget.maxActiveTasks && budget.maxActiveTasks > 0) {
        maxActive = budget.maxActiveTasks;
      }
    } catch {
      // Invalid JSON — use default
    }
  }

  const slotsAvailable = Math.max(0, maxActive - activeCount);
  if (slotsAvailable === 0) {
    logDecision(sql, missionId, null, 'skip',
      `${schedulable.length} schedulable task(s) held: concurrency limit reached (${activeCount}/${maxActive} active)`, now);
    return;
  }

  // Fetch project info (needed for startTaskRunnerDO)
  const projectRow = await env.DATABASE.prepare(
    `SELECT repository, installation_id, default_branch, default_vm_size, default_provider,
            default_location, default_agent_type, default_workspace_profile, default_devcontainer_config_name,
            task_execution_timeout_ms, max_workspaces_per_node, node_cpu_threshold_percent,
            node_memory_threshold_percent, warm_node_timeout_ms
     FROM projects WHERE id = ?`,
  ).bind(projectId).first<{
    repository: string;
    installation_id: string;
    default_branch: string;
    default_vm_size: string | null;
    default_provider: string | null;
    default_location: string | null;
    default_agent_type: string | null;
    default_workspace_profile: string | null;
    default_devcontainer_config_name: string | null;
    task_execution_timeout_ms: number | null;
    max_workspaces_per_node: number | null;
    node_cpu_threshold_percent: number | null;
    node_memory_threshold_percent: number | null;
    warm_node_timeout_ms: number | null;
  }>();

  if (!projectRow) {
    logDecision(sql, missionId, null, 'skip', 'Project not found — cannot dispatch', now);
    return;
  }

  const toDispatch = schedulable.slice(0, Math.min(slotsAvailable, config.maxDispatchesPerCycle));
  let dispatched = 0;

  for (const task of toDispatch) {
    try {
      // Resolve user info for git config
      const userRow = await env.DATABASE.prepare(
        'SELECT name, email, github_id FROM users WHERE id = ?',
      ).bind(task.user_id).first<{ name: string | null; email: string | null; github_id: string | null }>();

      // Resolve VM config from project defaults
      const resolvedProvider: CredentialProvider | null =
        typeof projectRow.default_provider === 'string' && isValidProvider(projectRow.default_provider)
          ? projectRow.default_provider
          : null;
      const resolvedVmSize: VMSize = (projectRow.default_vm_size as VMSize | null) ?? DEFAULT_VM_SIZE;
      const resolvedVmLocation: VMLocation = (projectRow.default_location as VMLocation | null)
        ?? (resolvedProvider ? getDefaultLocationForProvider(resolvedProvider) as VMLocation | null : null)
        ?? DEFAULT_VM_LOCATION;
      const resolvedWorkspaceProfile: WorkspaceProfile =
        (projectRow.default_workspace_profile as WorkspaceProfile | null) ?? DEFAULT_WORKSPACE_PROFILE;
      const resolvedDevcontainerConfig: string | null = resolvedWorkspaceProfile === 'lightweight'
        ? null
        : (projectRow.default_devcontainer_config_name ?? null);

      // Create chat session for the task
      const sessionId = await projectDataService.createSession(
        env, projectId, null, task.title, task.id,
      );

      if (task.description) {
        await projectDataService.persistMessage(env, projectId, sessionId, 'user', task.description, null);
      }

      // Transition task to queued → provisioning via status update
      await env.DATABASE.prepare(
        `UPDATE tasks SET status = 'queued', execution_step = 'node_selection', updated_at = ? WHERE id = ?`,
      ).bind(new Date().toISOString(), task.id).run();

      // Start the TaskRunner DO
      await startTaskRunnerDO(env, {
        taskId: task.id,
        projectId,
        userId: task.user_id,
        vmSize: resolvedVmSize,
        vmLocation: resolvedVmLocation,
        branch: projectRow.default_branch,
        userName: userRow?.name ?? null,
        userEmail: userRow?.email ?? null,
        githubId: userRow?.github_id ?? null,
        taskTitle: task.title,
        taskDescription: task.description ?? null,
        repository: projectRow.repository,
        installationId: projectRow.installation_id,
        outputBranch: task.output_branch ?? null,
        projectDefaultVmSize: projectRow.default_vm_size as VMSize | null,
        chatSessionId: sessionId,
        agentType: projectRow.default_agent_type ?? null,
        workspaceProfile: resolvedWorkspaceProfile,
        devcontainerConfigName: resolvedDevcontainerConfig,
        cloudProvider: resolvedProvider,
        projectScaling: {
          taskExecutionTimeoutMs: projectRow.task_execution_timeout_ms ?? null,
          maxWorkspacesPerNode: projectRow.max_workspaces_per_node ?? null,
          nodeCpuThresholdPercent: projectRow.node_cpu_threshold_percent ?? null,
          nodeMemoryThresholdPercent: projectRow.node_memory_threshold_percent ?? null,
          warmNodeTimeoutMs: projectRow.warm_node_timeout_ms ?? null,
        },
      });

      // Record in scheduling_queue
      sql.exec(
        `INSERT INTO scheduling_queue (id, mission_id, task_id, scheduled_at, dispatched_at, reason)
         VALUES (?, ?, ?, ?, ?, ?)`,
        ulid(), missionId, task.id, now, now, 'auto-dispatch: task became schedulable',
      );

      logDecision(sql, missionId, task.id, 'dispatch',
        `Auto-dispatched schedulable task (slot ${dispatched + 1}/${slotsAvailable})`, now);

      dispatched++;

      log.info('orchestrator.task_dispatched', {
        projectId, missionId, taskId: task.id, slot: dispatched, slotsAvailable,
      });
    } catch (err) {
      log.error('orchestrator.auto_dispatch_failed', {
        projectId, missionId, taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      logDecision(sql, missionId, task.id, 'skip',
        `Auto-dispatch failed: ${err instanceof Error ? err.message : String(err)}`, now);
    }
  }

  if (dispatched > 0) {
    // Update last_dispatch_at
    sql.exec(
      'UPDATE orchestrator_missions SET last_dispatch_at = ? WHERE mission_id = ?',
      now, missionId,
    );
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
  // Check if we already routed handoffs for this task in this mission
  const alreadyRouted = sql.exec(
    `SELECT 1 FROM decision_log WHERE mission_id = ? AND task_id = ? AND action = 'handoff_routed' LIMIT 1`,
    missionId, completedTaskId,
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
