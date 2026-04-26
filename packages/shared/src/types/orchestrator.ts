/**
 * Project Orchestrator types (Phase 3: Orchestration).
 *
 * The ProjectOrchestrator DO is a per-project "brain" that coordinates agent work:
 * watches missions, manages task scheduling, sends durable messages, and makes
 * reactive decisions.
 */

import type { SchedulerState } from './mission';

// ── Orchestrator Mission Tracking ─────────────────────────────────────────────

/** State of a mission as tracked by the orchestrator */
export interface OrchestratorMissionEntry {
  missionId: string;
  status: 'active' | 'paused' | 'completing';
  lastCheckedAt: number;
  lastDispatchAt: number | null;
  registeredAt: number;
}

// ── Scheduling ────────────────────────────────────────────────────────────────

/** A task queued for dispatch by the orchestrator */
export interface SchedulingQueueEntry {
  id: string;
  missionId: string;
  taskId: string;
  scheduledAt: number;
  dispatchedAt: number | null;
  reason: string;
}

/** A decision logged by the orchestrator for auditability */
export interface DecisionLogEntry {
  id: string;
  missionId: string;
  taskId: string | null;
  action: DecisionAction;
  reason: string;
  metadata: Record<string, unknown> | null;
  createdAt: number;
}

export type DecisionAction =
  | 'dispatch'
  | 'block'
  | 'unblock'
  | 'stall_detected'
  | 'interrupt_sent'
  | 'handoff_routed'
  | 'pause'
  | 'resume'
  | 'cancel'
  | 'override'
  | 'retry'
  | 'skip';

export const DECISION_ACTIONS: readonly DecisionAction[] = [
  'dispatch',
  'block',
  'unblock',
  'stall_detected',
  'interrupt_sent',
  'handoff_routed',
  'pause',
  'resume',
  'cancel',
  'override',
  'retry',
  'skip',
] as const;

// ── Orchestrator Status ───────────────────────────────────────────────────────

/** Full status returned by getStatus() */
export interface OrchestratorStatus {
  projectId: string;
  activeMissions: OrchestratorMissionEntry[];
  schedulingQueue: SchedulingQueueEntry[];
  recentDecisions: DecisionLogEntry[];
  nextAlarmAt: number | null;
  schedulingIntervalMs: number;
}

// ── Override Request ──────────────────────────────────────────────────────────

/** Supported scheduler states for manual override */
export const OVERRIDABLE_SCHEDULER_STATES: readonly SchedulerState[] = [
  'schedulable',
  'blocked_human',
  'blocked_resource',
  'cancelled',
] as const;

export interface OverrideTaskStateRequest {
  taskId: string;
  newState: SchedulerState;
  reason: string;
}

// ── Task Event Notification ───────────────────────────────────────────────────

export type TaskEventType = 'completed' | 'failed' | 'cancelled' | 'stalled';

export interface TaskEventNotification {
  taskId: string;
  missionId: string;
  event: TaskEventType;
  timestamp: number;
}
