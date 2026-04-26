/**
 * ProjectOrchestrator DO Service — helper functions for Worker routes
 * to interact with the ProjectOrchestrator Durable Object.
 */
import type {
  OrchestratorStatus,
  SchedulerState,
  SchedulingQueueEntry,
  TaskEventNotification,
} from '@simple-agent-manager/shared';

import type { ProjectOrchestrator } from '../durable-objects/project-orchestrator';
import type { Env } from '../env';

/**
 * Get a typed DO stub for the given project.
 * Uses `idFromName(projectId)` — one orchestrator per project.
 */
function getStub(env: Env, projectId: string): DurableObjectStub<ProjectOrchestrator> {
  const id = env.PROJECT_ORCHESTRATOR.idFromName(projectId);
  return env.PROJECT_ORCHESTRATOR.get(id) as DurableObjectStub<ProjectOrchestrator>;
}

/** Register a mission and arm the scheduling alarm. */
export async function startOrchestration(env: Env, projectId: string, missionId: string): Promise<void> {
  const stub = getStub(env, projectId);
  return stub.startOrchestration(projectId, missionId);
}

/** Pause a mission (running tasks continue, new dispatches stop). */
export async function pauseMission(env: Env, projectId: string, missionId: string): Promise<boolean> {
  const stub = getStub(env, projectId);
  return stub.pauseMission(projectId, missionId);
}

/** Resume a paused mission. */
export async function resumeMission(env: Env, projectId: string, missionId: string): Promise<boolean> {
  const stub = getStub(env, projectId);
  return stub.resumeMission(projectId, missionId);
}

/** Cancel a mission and all non-terminal tasks. */
export async function cancelMission(env: Env, projectId: string, missionId: string): Promise<boolean> {
  const stub = getStub(env, projectId);
  return stub.cancelMission(projectId, missionId);
}

/** Override a task's scheduler state manually. */
export async function overrideTaskState(
  env: Env,
  projectId: string,
  missionId: string,
  taskId: string,
  newState: SchedulerState,
  reason: string,
): Promise<boolean> {
  const stub = getStub(env, projectId);
  return stub.overrideTaskState(projectId, missionId, taskId, newState, reason);
}

/** Notify the orchestrator of a task event (completion, failure, etc.). */
export async function notifyTaskEvent(env: Env, projectId: string, notification: TaskEventNotification): Promise<void> {
  const stub = getStub(env, projectId);
  return stub.notifyTaskEvent(projectId, notification);
}

/** Get orchestrator status (active missions, queue, recent decisions). */
export async function getOrchestratorStatus(env: Env, projectId: string): Promise<OrchestratorStatus> {
  const stub = getStub(env, projectId);
  return stub.getStatus(projectId);
}

/** Get the scheduling queue (pending dispatches). */
export async function getSchedulingQueue(env: Env, projectId: string): Promise<SchedulingQueueEntry[]> {
  const stub = getStub(env, projectId);
  return stub.getSchedulingQueue(projectId);
}
