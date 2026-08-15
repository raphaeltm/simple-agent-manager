import * as v from 'valibot';

/**
 * Orchestrator override request schema (apps/api/src/routes/orchestrator.ts
 * POST /tasks/:taskId/override). `missionId`/`reason` are typed as strings
 * because the handler passes them directly to `overrideTaskState(...)`,
 * whose parameters are declared `missionId: string` / `reason: string` —
 * with the existing `if (!body.missionId || ...)` guard narrowing away
 * `undefined`, this preserves the exact "Missing missionId, newState, or
 * reason" behavior for a missing field while turning a wrong-type value
 * into a normal 400 instead of an unpredictable D1 bind. `newState` stays
 * unknown: the handler already casts it (`body.newState as SchedulerState`)
 * before its own allowlist check, so nothing further is gained by typing it
 * here, and the check's exact "Invalid state: ..." message is preserved
 * for every input type.
 */
export const OverrideTaskStateSchema = v.object({
  missionId: v.optional(v.string()),
  newState: v.optional(v.unknown()),
  reason: v.optional(v.string()),
});
