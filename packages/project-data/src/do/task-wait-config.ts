import {
  DEFAULT_ORCHESTRATOR_WAIT_MAX_ACTIVE_PER_PROJECT,
  DEFAULT_ORCHESTRATOR_WAIT_MAX_CANDIDATES_PER_ALARM,
  DEFAULT_ORCHESTRATOR_WAIT_MAX_CHILDREN,
  DEFAULT_ORCHESTRATOR_WAIT_MAX_DURATION_MS,
  DEFAULT_ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS,
  MAX_ORCHESTRATOR_WAIT_CHILDREN,
} from '@simple-agent-manager/shared';

import type { Env } from './types';

export interface TaskWaitConfig {
  reconcileIntervalMs: number;
  maxChildren: number;
  maxActivePerProject: number;
  maxDurationMs: number;
  maxCandidatesPerAlarm: number;
}

function parsePositive(
  value: string | undefined,
  fallback: number,
  name: string,
  maximum?: number
): number {
  if (value === undefined || value.trim() === '') return fallback;
  const parsed = Number.parseInt(value, 10);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive safe integer`);
  }
  if (maximum !== undefined && parsed > maximum) {
    throw new Error(`${name} must be at most ${maximum}`);
  }
  return parsed;
}

export function resolveTaskWaitConfig(env: Env): TaskWaitConfig {
  return {
    reconcileIntervalMs: parsePositive(
      env.ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS,
      DEFAULT_ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS,
      'ORCHESTRATOR_WAIT_RECONCILE_INTERVAL_MS'
    ),
    maxChildren: parsePositive(
      env.ORCHESTRATOR_WAIT_MAX_CHILDREN,
      DEFAULT_ORCHESTRATOR_WAIT_MAX_CHILDREN,
      'ORCHESTRATOR_WAIT_MAX_CHILDREN',
      MAX_ORCHESTRATOR_WAIT_CHILDREN
    ),
    maxActivePerProject: parsePositive(
      env.ORCHESTRATOR_WAIT_MAX_ACTIVE_PER_PROJECT,
      DEFAULT_ORCHESTRATOR_WAIT_MAX_ACTIVE_PER_PROJECT,
      'ORCHESTRATOR_WAIT_MAX_ACTIVE_PER_PROJECT'
    ),
    maxDurationMs: parsePositive(
      env.ORCHESTRATOR_WAIT_MAX_DURATION_MS,
      DEFAULT_ORCHESTRATOR_WAIT_MAX_DURATION_MS,
      'ORCHESTRATOR_WAIT_MAX_DURATION_MS'
    ),
    maxCandidatesPerAlarm: parsePositive(
      env.ORCHESTRATOR_WAIT_MAX_CANDIDATES_PER_ALARM,
      DEFAULT_ORCHESTRATOR_WAIT_MAX_CANDIDATES_PER_ALARM,
      'ORCHESTRATOR_WAIT_MAX_CANDIDATES_PER_ALARM'
    ),
  };
}
