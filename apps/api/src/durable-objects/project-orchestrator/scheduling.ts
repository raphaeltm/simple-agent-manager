/**
 * ProjectOrchestrator — scheduling logic.
 *
 * Handles the core scheduling loop: check for task completions, route
 * handoff packets, recompute scheduler states, detect stalls, and
 * log decisions.
 */
import type { HandoffFact } from '@simple-agent-manager/shared';
import type { HandoffPacket } from '@simple-agent-manager/shared';
import type { OrchestratorConfig } from '@simple-agent-manager/shared';
import type {
  CredentialProvider,
  VMLocation,
  VMSize,
  WorkspaceProfile,
} from '@simple-agent-manager/shared';
import {
  DEFAULT_VM_LOCATION,
  DEFAULT_VM_SIZE,
  DEFAULT_WORKSPACE_PROFILE,
  getDefaultLocationForProvider,
  isValidProvider,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { expectJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';
import * as projectDataService from '../../services/project-data';
import { recomputeMissionSchedulerStates } from '../../services/scheduler-state-sync';
import { startTaskRunnerDO } from '../../services/task-runner-do';
import { mapRows } from '../row-validation';
import { logDecision } from './decision-log';
import { detectStalls, resolveActiveSessionIdsForTaskIds } from './stall-detection';

// ── Types ─────────────────────────────────────────────────────────────────────

interface TaskRow {
  id: string;
  status: string;
  scheduler_state: string | null;
  mission_id: string | null;
  updated_at: string;
}

type RoutableHandoff = Pick<
  HandoffPacket,
  'id' | 'summary' | 'facts' | 'openQuestions' | 'suggestedActions'
>;

const handoffFactObjectSchema = v.object({
  key: v.optional(v.string()),
  value: v.optional(v.string()),
  fact: v.optional(v.string()),
});

const routableHandoffSchema = v.object({
  id: v.string(),
  summary: v.string(),
  facts: v.optional(v.array(v.union([v.string(), handoffFactObjectSchema]))),
  openQuestions: v.optional(v.array(v.string())),
  suggestedActions: v.optional(v.array(v.string())),
});

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
        `SELECT mission_id, status, registered_at
           FROM orchestrator_missions
           WHERE status IN ('active', 'completing')`
      )
      .toArray(),
    SchedulingMissionRowSchema,
    'orchestrator.scheduling_missions_list',
    'mission_id'
  );

  if (missions.length === 0) return;

  for (const mission of missions) {
    try {
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

interface DispatchableTaskRow {
  id: string;
  title: string;
  description: string | null;
  user_id: string;
  project_id: string;
  output_branch: string | null;
  agent_profile_hint: string | null;
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
  now: number
): Promise<void> {
  // Re-read task states from D1 (fresh after recompute)
  const schedulableResult = await env.DATABASE.prepare(
    `SELECT id, title, description, user_id, project_id, output_branch, agent_profile_hint, dispatch_depth, priority
     FROM tasks
     WHERE mission_id = ?
       AND scheduler_state = 'schedulable'
       AND status = 'queued'
       AND chat_session_id IS NULL
       AND NOT EXISTS (
         SELECT 1
         FROM vm_task_admissions
         WHERE vm_task_admissions.task_id = tasks.id
           AND vm_task_admissions.state IN (
             'queued', 'waiting', 'provisioning_granted', 'provisioning', 'node_ready'
           )
       )
     ORDER BY priority DESC, created_at ASC
     LIMIT ?`
  )
    .bind(missionId, config.maxDispatchesPerCycle)
    .all<DispatchableTaskRow>();

  const schedulable = schedulableResult.results ?? [];
  if (schedulable.length === 0) return;

  // Check concurrency limit: count currently active tasks in this mission
  const activeCountResult = await env.DATABASE.prepare(
    `SELECT COUNT(*) as cnt FROM tasks
     WHERE mission_id = ?
       AND (
         status IN ('in_progress', 'delegated')
         OR (status = 'queued' AND chat_session_id IS NOT NULL)
         OR EXISTS (
           SELECT 1
           FROM vm_task_admissions
           WHERE vm_task_admissions.task_id = tasks.id
             AND vm_task_admissions.state IN (
               'queued', 'waiting', 'provisioning_granted', 'provisioning', 'node_ready'
             )
         )
       )`
  )
    .bind(missionId)
    .first<{ cnt: number }>();

  const activeCount = activeCountResult?.cnt ?? 0;

  // Resolve max active tasks from mission budget_config
  const missionRow = await env.DATABASE.prepare('SELECT budget_config FROM missions WHERE id = ?')
    .bind(missionId)
    .first<{ budget_config: string | null }>();

  let maxActive = config.maxActiveTasksPerMission;
  if (missionRow?.budget_config) {
    try {
      const budget = expectJsonRecord(
        JSON.parse(missionRow.budget_config),
        'mission.budget_config'
      );
      if (typeof budget.maxActiveTasks === 'number' && budget.maxActiveTasks > 0) {
        maxActive = budget.maxActiveTasks;
      }
    } catch {
      // Invalid JSON — use default
    }
  }

  const slotsAvailable = Math.max(0, maxActive - activeCount);
  if (slotsAvailable === 0) {
    logDecision(
      sql,
      missionId,
      null,
      'skip',
      `${schedulable.length} schedulable task(s) held: concurrency limit reached (${activeCount}/${maxActive} active)`,
      now
    );
    return;
  }

  // Fetch project info (needed for startTaskRunnerDO)
  const projectRow = await env.DATABASE.prepare(
    `SELECT repository, installation_id, default_branch, default_vm_size, default_provider,
            default_location, default_agent_type, default_workspace_profile, default_devcontainer_config_name,
            task_execution_timeout_ms, max_workspaces_per_node, node_cpu_threshold_percent,
            node_memory_threshold_percent, warm_node_timeout_ms
     FROM projects WHERE id = ?`
  )
    .bind(projectId)
    .first<{
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
        'SELECT name, email, github_id FROM users WHERE id = ?'
      )
        .bind(task.user_id)
        .first<{ name: string | null; email: string | null; github_id: string | null }>();

      // Resolve VM config from project defaults
      const resolvedProvider: CredentialProvider | null =
        typeof projectRow.default_provider === 'string' &&
        isValidProvider(projectRow.default_provider)
          ? projectRow.default_provider
          : null;
      const resolvedVmSize: VMSize =
        (projectRow.default_vm_size as VMSize | null) ?? DEFAULT_VM_SIZE;
      const resolvedVmLocation: VMLocation =
        (projectRow.default_location as VMLocation | null) ??
        (resolvedProvider
          ? (getDefaultLocationForProvider(resolvedProvider) as VMLocation | null)
          : null) ??
        DEFAULT_VM_LOCATION;
      const resolvedWorkspaceProfile: WorkspaceProfile =
        (projectRow.default_workspace_profile as WorkspaceProfile | null) ??
        DEFAULT_WORKSPACE_PROFILE;
      const resolvedDevcontainerConfig: string | null =
        resolvedWorkspaceProfile === 'lightweight'
          ? null
          : (projectRow.default_devcontainer_config_name ?? null);

      // Create chat session for the task
      const sessionId = await projectDataService.createSession(
        env,
        projectId,
        null,
        task.title,
        task.id,
        task.user_id
      );

      if (task.description) {
        await projectDataService.persistMessage(
          env,
          projectId,
          sessionId,
          'user',
          task.description,
          null
        );
      }

      // Transition task to queued → provisioning via status update
      const dispatchTransition = await env.DATABASE.prepare(
        `UPDATE tasks
         SET status = 'queued', chat_session_id = ?, execution_step = 'node_selection', updated_at = ?
         WHERE id = ? AND (chat_session_id IS NULL OR chat_session_id = ?)`
      )
        .bind(sessionId, new Date().toISOString(), task.id, sessionId)
        .run();
      if (!dispatchTransition.meta.changes) {
        throw new Error('Task was already bound to a different chat session');
      }

      // Start the TaskRunner DO
      await startTaskRunnerDO(env, {
        taskId: task.id,
        projectId,
        userId: task.user_id,
        vmSize: resolvedVmSize,
        vmLocation: resolvedVmLocation,
        branch: projectRow.default_branch,
        defaultBranch: projectRow.default_branch,
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
        agentProfileHint: task.agent_profile_hint ?? null,
        effort: null,
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
        ulid(),
        missionId,
        task.id,
        now,
        now,
        'auto-dispatch: task became schedulable'
      );

      logDecision(
        sql,
        missionId,
        task.id,
        'dispatch',
        `Auto-dispatched schedulable task (slot ${dispatched + 1}/${slotsAvailable})`,
        now
      );

      dispatched++;

      log.info('orchestrator.task_dispatched', {
        projectId,
        missionId,
        taskId: task.id,
        slot: dispatched,
        slotsAvailable,
      });
    } catch (err) {
      log.error('orchestrator.auto_dispatch_failed', {
        projectId,
        missionId,
        taskId: task.id,
        error: err instanceof Error ? err.message : String(err),
      });
      logDecision(
        sql,
        missionId,
        task.id,
        'skip',
        `Auto-dispatch failed: ${err instanceof Error ? err.message : String(err)}`,
        now
      );
    }
  }

  if (dispatched > 0) {
    // Update last_dispatch_at
    sql.exec(
      'UPDATE orchestrator_missions SET last_dispatch_at = ? WHERE mission_id = ?',
      now,
      missionId
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

/** Build a readable content string from a handoff packet for durable message delivery. */
function buildHandoffContent(fromTaskId: string, handoff: RoutableHandoff): string {
  const parts: string[] = [
    `Handoff from task ${fromTaskId}:`,
    '',
    `**Summary:** ${handoff.summary}`,
  ];
  if (handoff.facts.length > 0) {
    const facts = handoff.facts.map((fact) => `- ${fact.key}: ${fact.value}`).join('\n');
    parts.push('', `**Key Facts:**\n${facts}`);
  }
  if (handoff.openQuestions.length > 0) {
    const qs = handoff.openQuestions.map((q) => `- ${q}`).join('\n');
    parts.push('', `**Open Questions:**\n${qs}`);
  }
  if (handoff.suggestedActions.length > 0) {
    const acts = handoff.suggestedActions.map((a) => `- ${a}`).join('\n');
    parts.push('', `**Suggested Actions:**\n${acts}`);
  }
  return parts.join('\n');
}

function parseRoutableHandoff(value: unknown): RoutableHandoff | null {
  const parsed = v.safeParse(routableHandoffSchema, value);
  if (!parsed.success) return null;

  return {
    id: parsed.output.id,
    summary: parsed.output.summary,
    facts: readHandoffFacts(parsed.output.facts),
    openQuestions: parsed.output.openQuestions ?? [],
    suggestedActions: parsed.output.suggestedActions ?? [],
  };
}

function readHandoffFacts(
  value: NonNullable<v.InferOutput<typeof routableHandoffSchema>['facts']> | undefined
): HandoffFact[] {
  return (value ?? []).flatMap((item): HandoffFact[] => {
    if (typeof item === 'string') {
      return [{ key: 'fact', value: item }];
    }
    const key = item.key ? item.key : item.fact ? 'fact' : null;
    const factValue = item.value ? item.value : (item.fact ?? null);
    return key && factValue ? [{ key, value: factValue }] : [];
  });
}
