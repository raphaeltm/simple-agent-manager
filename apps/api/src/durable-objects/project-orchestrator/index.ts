/**
 * ProjectOrchestrator Durable Object — per-project orchestration brain (Phase 3).
 *
 * One instance per project, keyed by projectId:
 *   env.PROJECT_ORCHESTRATOR.idFromName(projectId)
 *
 * Coordinates agent work within a project:
 * - Watches missions and manages their lifecycle
 * - Routes handoff packets between tasks via durable messages
 * - Detects stalled tasks and sends interrupt messages
 * - Logs all scheduling decisions for auditability
 *
 * Alarm-driven: wakes on a configurable interval (default 30s) to run
 * the scheduling loop. Sleeps when no active missions exist.
 */
import type {
  DecisionLogEntry,
  OrchestratorMissionEntry,
  OrchestratorStatus,
  SchedulerState,
  SchedulingQueueEntry,
  TaskEventNotification,
} from '@simple-agent-manager/shared';
import {
  OVERRIDABLE_SCHEDULER_STATES,
  resolveOrchestratorConfig,
} from '@simple-agent-manager/shared';
import { DurableObject } from 'cloudflare:workers';
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { deferAlarmWhenDisabled } from '../../services/operational-kill-switch';
import { mapRows, parseRowOrNull } from '../row-validation';
import { logDecision, pruneDecisionLog } from './decision-log';
import { runOrchestratorMigrations } from './migrations';
import { runSchedulingCycle } from './scheduling';

// =============================================================================
// DO-SQLite row schemas — orchestrator-specific (see ../row-validation for the
// generic mapRows/parseRowOrNull helpers). Field sets mirror the CREATE TABLE
// statements in ./migrations.ts exactly, so a plain (non-strict) v.object()
// validates every column a `SELECT *` can return.
// =============================================================================

const OrchestratorMissionRowSchema = v.object({
  mission_id: v.string(),
  status: v.string(),
  last_checked_at: v.number(),
  last_dispatch_at: v.nullable(v.number()),
  registered_at: v.number(),
});

const SchedulingQueueRowSchema = v.object({
  id: v.string(),
  mission_id: v.string(),
  task_id: v.string(),
  scheduled_at: v.number(),
  dispatched_at: v.nullable(v.number()),
  reason: v.string(),
});

const DecisionLogRowSchema = v.object({
  id: v.string(),
  mission_id: v.string(),
  task_id: v.nullable(v.string()),
  action: v.string(),
  reason: v.string(),
  metadata: v.nullable(v.string()),
  created_at: v.number(),
});

/** `SELECT mission_id FROM orchestrator_missions LIMIT 1` shape. */
const MissionIdRowSchema = v.object({ mission_id: v.string() });

export class ProjectOrchestrator extends DurableObject<Env> {
  private projectId: string | null = null;

  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    // Run migrations atomically on first access
    ctx.blockConcurrencyWhile(async () => {
      runOrchestratorMigrations(ctx.storage.sql);
    });
  }

  // =========================================================================
  // Public RPCs
  // =========================================================================

  /**
   * Register a mission for orchestration and arm the scheduling alarm.
   * Called when a mission is created (create_mission MCP tool).
   */
  async startOrchestration(projectId: string, missionId: string): Promise<void> {
    this.projectId = projectId;
    await this.ctx.storage.put('projectId', projectId);
    const now = Date.now();
    const sql = this.ctx.storage.sql;

    // Idempotent: skip if already registered
    const existing = sql
      .exec('SELECT 1 FROM orchestrator_missions WHERE mission_id = ?', missionId)
      .toArray();
    if (existing.length > 0) {
      await this.armAlarm();
      return;
    }

    sql.exec(
      `INSERT INTO orchestrator_missions (mission_id, status, last_checked_at, last_dispatch_at, registered_at)
       VALUES (?, 'active', ?, NULL, ?)`,
      missionId,
      now,
      now
    );

    logDecision(sql, missionId, null, 'dispatch', 'Mission registered for orchestration', now);
    log.info('orchestrator.mission_registered', { projectId, missionId });

    // Arm the scheduling alarm
    await this.armAlarm();
  }

  /**
   * Pause a mission — stops scheduling new tasks but running tasks continue.
   */
  async pauseMission(projectId: string, missionId: string): Promise<boolean> {
    this.projectId = projectId;
    const sql = this.ctx.storage.sql;
    const result = sql.exec(
      `UPDATE orchestrator_missions SET status = 'paused' WHERE mission_id = ? AND status = 'active'`,
      missionId
    );
    if (result.rowsWritten === 0) return false;

    logDecision(sql, missionId, null, 'pause', 'Mission paused by user', Date.now());

    // Update D1 mission status
    await this.env.DATABASE.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
      .bind('paused', new Date().toISOString(), missionId)
      .run();

    log.info('orchestrator.mission_paused', { projectId, missionId });
    return true;
  }

  /**
   * Resume a paused mission — re-enables scheduling.
   */
  async resumeMission(projectId: string, missionId: string): Promise<boolean> {
    this.projectId = projectId;
    const sql = this.ctx.storage.sql;
    const result = sql.exec(
      `UPDATE orchestrator_missions SET status = 'active' WHERE mission_id = ? AND status = 'paused'`,
      missionId
    );
    if (result.rowsWritten === 0) return false;

    logDecision(sql, missionId, null, 'resume', 'Mission resumed by user', Date.now());

    // Update D1 mission status
    await this.env.DATABASE.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
      .bind('active', new Date().toISOString(), missionId)
      .run();

    log.info('orchestrator.mission_resumed', { projectId, missionId });
    await this.armAlarm();
    return true;
  }

  /**
   * Cancel a mission — marks pending tasks as cancelled.
   */
  async cancelMission(projectId: string, missionId: string): Promise<boolean> {
    this.projectId = projectId;
    const sql = this.ctx.storage.sql;

    // Verify mission is tracked before proceeding
    const tracked = sql
      .exec(`SELECT 1 FROM orchestrator_missions WHERE mission_id = ?`, missionId)
      .toArray();
    if (tracked.length === 0) return false;

    // Update D1 first (source of truth) — cancel tasks and mission
    const now = new Date().toISOString();
    await this.env.DATABASE.prepare(
      `UPDATE tasks SET status = 'cancelled', scheduler_state = 'cancelled', updated_at = ?
       WHERE mission_id = ? AND status NOT IN ('completed', 'failed', 'cancelled')`
    )
      .bind(now, missionId)
      .run();

    await this.env.DATABASE.prepare('UPDATE missions SET status = ?, updated_at = ? WHERE id = ?')
      .bind('cancelled', now, missionId)
      .run();

    // Then remove from DO tracking
    sql.exec(`DELETE FROM orchestrator_missions WHERE mission_id = ?`, missionId);
    sql.exec('DELETE FROM scheduling_queue WHERE mission_id = ?', missionId);

    logDecision(sql, missionId, null, 'cancel', 'Mission cancelled by user', Date.now());
    log.info('orchestrator.mission_cancelled', { projectId, missionId });

    return true;
  }

  /**
   * Override a task's scheduler state manually.
   */
  async overrideTaskState(
    projectId: string,
    missionId: string,
    taskId: string,
    newState: SchedulerState,
    reason: string
  ): Promise<boolean> {
    this.projectId = projectId;

    if (!OVERRIDABLE_SCHEDULER_STATES.includes(newState)) {
      return false;
    }

    const sql = this.ctx.storage.sql;
    const tracked = sql
      .exec(`SELECT 1 FROM orchestrator_missions WHERE mission_id = ?`, missionId)
      .toArray();
    if (tracked.length === 0) return false;

    const targetTask = await this.env.DATABASE.prepare(
      `SELECT project_id AS projectId
       FROM tasks
       WHERE id = ? AND mission_id = ?
       LIMIT 1`
    )
      .bind(taskId, missionId)
      .first<{ projectId: string }>();

    if (!targetTask) return false;

    if (targetTask.projectId !== projectId) {
      log.warn('orchestrator.override_task_state.project_mismatch', {
        projectId,
        callerProjectId: projectId,
        missionId,
        taskId,
        targetProjectId: targetTask.projectId,
        expectedProjectId: projectId,
        receivedProjectId: targetTask.projectId,
        action: 'rejected',
      });
      return false;
    }

    const now = new Date().toISOString();
    const result = await this.env.DATABASE.prepare(
      'UPDATE tasks SET scheduler_state = ?, updated_at = ? WHERE id = ? AND mission_id = ? AND project_id = ?'
    )
      .bind(newState, now, taskId, missionId, projectId)
      .run();

    if (!result.meta.changes || result.meta.changes === 0) return false;

    logDecision(
      this.ctx.storage.sql,
      missionId,
      taskId,
      'override',
      `Scheduler state overridden to '${newState}': ${reason}`,
      Date.now()
    );

    log.info('orchestrator.task_state_overridden', { projectId, missionId, taskId, newState });
    return true;
  }

  /**
   * Notify the orchestrator of a task event (completion, failure, etc.).
   * Triggers an immediate scheduling cycle for the affected mission.
   */
  async notifyTaskEvent(projectId: string, notification: TaskEventNotification): Promise<void> {
    this.projectId = projectId;
    const sql = this.ctx.storage.sql;

    // Check if this mission is tracked
    const mission = sql
      .exec(
        `SELECT mission_id FROM orchestrator_missions WHERE mission_id = ? AND status = 'active'`,
        notification.missionId
      )
      .toArray();

    if (mission.length === 0) return; // Not orchestrated

    log.info('orchestrator.task_event_received', {
      projectId,
      missionId: notification.missionId,
      taskId: notification.taskId,
      event: notification.event,
    });

    // Trigger immediate scheduling cycle — only if no closer alarm exists
    const existingAlarm = await this.ctx.storage.getAlarm();
    const now = Date.now();
    if (existingAlarm === null || existingAlarm > now) {
      await this.ctx.storage.setAlarm(now);
    }
  }

  /**
   * Return the current orchestrator status.
   */
  async getStatus(projectId: string): Promise<OrchestratorStatus> {
    this.projectId = projectId;
    const sql = this.ctx.storage.sql;
    const config = resolveOrchestratorConfig(this.env);

    const missions = mapRows(
      sql.exec('SELECT * FROM orchestrator_missions ORDER BY registered_at DESC').toArray(),
      OrchestratorMissionRowSchema,
      'orchestrator.missions_list',
      'mission_id'
    );

    const queue = mapRows(
      sql
        .exec(
          'SELECT * FROM scheduling_queue WHERE dispatched_at IS NULL ORDER BY scheduled_at ASC'
        )
        .toArray(),
      SchedulingQueueRowSchema,
      'orchestrator.queue_list'
    );

    const decisions = mapRows(
      sql
        .exec(
          'SELECT * FROM decision_log ORDER BY created_at DESC LIMIT ?',
          config.recentDecisionsLimit
        )
        .toArray(),
      DecisionLogRowSchema,
      'orchestrator.decisions_list'
    );

    const alarm = await this.ctx.storage.getAlarm();

    return {
      projectId,
      activeMissions: missions.map((m) => ({
        missionId: m.mission_id,
        status: m.status as OrchestratorMissionEntry['status'],
        lastCheckedAt: m.last_checked_at,
        lastDispatchAt: m.last_dispatch_at,
        registeredAt: m.registered_at,
      })),
      schedulingQueue: queue.map((q) => ({
        id: q.id,
        missionId: q.mission_id,
        taskId: q.task_id,
        scheduledAt: q.scheduled_at,
        dispatchedAt: q.dispatched_at,
        reason: q.reason,
      })),
      recentDecisions: decisions.map((d) => ({
        id: d.id,
        missionId: d.mission_id,
        taskId: d.task_id,
        action: d.action as DecisionLogEntry['action'],
        reason: d.reason,
        metadata: d.metadata ? JSON.parse(d.metadata) : null,
        createdAt: d.created_at,
      })),
      nextAlarmAt: alarm,
      schedulingIntervalMs: config.schedulingIntervalMs,
    };
  }

  /**
   * Return the scheduling queue (pending dispatches).
   */
  async getSchedulingQueue(projectId: string): Promise<SchedulingQueueEntry[]> {
    this.projectId = projectId;
    const sql = this.ctx.storage.sql;

    const queue = mapRows(
      sql
        .exec(
          'SELECT * FROM scheduling_queue WHERE dispatched_at IS NULL ORDER BY scheduled_at ASC'
        )
        .toArray(),
      SchedulingQueueRowSchema,
      'orchestrator.queue_list'
    );

    return queue.map((q) => ({
      id: q.id,
      missionId: q.mission_id,
      taskId: q.task_id,
      scheduledAt: q.scheduled_at,
      dispatchedAt: q.dispatched_at,
      reason: q.reason,
    }));
  }

  // =========================================================================
  // Alarm Handler
  // =========================================================================

  override async alarm(): Promise<void> {
    if (await deferAlarmWhenDisabled(this.env, this.ctx.storage, 'ProjectOrchestrator')) return;

    const config = resolveOrchestratorConfig(this.env);

    // Need to know which project this DO belongs to
    // Extract from the first mission's project_id, or from stored projectId
    const projectId = await this.resolveProjectId();
    if (!projectId) return; // No active missions, nothing to do

    try {
      await runSchedulingCycle(this.ctx.storage.sql, this.env, projectId, config);
    } catch (err) {
      log.error('orchestrator.alarm.cycle_failed', {
        projectId,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Prune decision log
    pruneDecisionLog(this.ctx.storage.sql, config.decisionLogMaxEntries);

    // Re-arm while active or legacy completing missions still need work.
    const activeMissions = this.ctx.storage.sql
      .exec(`SELECT 1 FROM orchestrator_missions WHERE status IN ('active', 'completing') LIMIT 1`)
      .toArray();

    if (activeMissions.length > 0) {
      await this.ctx.storage.setAlarm(Date.now() + config.schedulingIntervalMs);
    }
  }

  // =========================================================================
  // Helpers
  // =========================================================================

  private async armAlarm(): Promise<void> {
    const config = resolveOrchestratorConfig(this.env);
    const existing = await this.ctx.storage.getAlarm();
    if (existing === null) {
      await this.ctx.storage.setAlarm(Date.now() + config.schedulingIntervalMs);
    }
  }

  private async resolveProjectId(): Promise<string | null> {
    if (this.projectId) return this.projectId;

    // Try from DO storage first (persisted on first RPC call)
    const stored = await this.ctx.storage.get<string>('projectId');
    if (stored) {
      this.projectId = stored;
      return stored;
    }

    // Fallback: resolve from the first mission via D1
    const firstMission = parseRowOrNull(
      this.ctx.storage.sql
        .exec('SELECT mission_id FROM orchestrator_missions LIMIT 1')
        .toArray()[0],
      MissionIdRowSchema,
      'orchestrator.resolve_project_id',
      'mission_id'
    );

    if (!firstMission) return null;

    const result = await this.env.DATABASE.prepare('SELECT project_id FROM missions WHERE id = ?')
      .bind(firstMission.mission_id)
      .first<{ project_id: string }>();

    if (result) {
      this.projectId = result.project_id;
      // Persist for future alarm calls
      await this.ctx.storage.put('projectId', result.project_id);
    }
    return this.projectId;
  }
}
