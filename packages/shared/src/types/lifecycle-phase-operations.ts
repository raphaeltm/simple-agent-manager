/**
 * Every operation a stored lifecycle phase timing can name (`lifecycle_phase_timings.operation`).
 * Written by `recordLifecycleTimings` (VM agent: provision, workspace, sleep, wake) and
 * `recordRunnerPhase` (TaskRunner: runner_start, runner_wake) in apps/api; read by
 * `phaseDurationStats` in packages/operations. Runner rows never share a phase name with VM rows.
 */
export const LIFECYCLE_PHASE_OPERATIONS = [
  'provision',
  'workspace',
  'sleep',
  'wake',
  'runner_start',
  'runner_wake',
] as const;
export type LifecyclePhaseOperation = (typeof LIFECYCLE_PHASE_OPERATIONS)[number];

/** Operations stored with a project: `provision` rows are node-level and never project-scoped. */
export const PROJECT_LIFECYCLE_PHASE_OPERATIONS = [
  'workspace',
  'sleep',
  'wake',
  'runner_start',
  'runner_wake',
] as const satisfies readonly LifecyclePhaseOperation[];
