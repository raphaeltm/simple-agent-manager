import { ProjectEventValidationError } from './project-events-contracts';

/**
 * A scheduled message whose target chat has ended: its task is finished or cancelled, or the
 * chat itself stopped. Nothing is left to wake, so this is a normal end, not a failure, and the
 * runner records the schedule as cancelled (`runScheduleAlarm`).
 *
 * It keeps the parent's `name`, so every caller that maps `ProjectEventValidationError` by
 * name across a Durable Object RPC still sees an ordinary validation refusal.
 */
export class ScheduleTargetEndedError extends ProjectEventValidationError {}
