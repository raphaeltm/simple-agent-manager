import * as schema from '@simple-agent-manager/worker-core/schema';
import { and, eq, ne, or, type SQL, sql } from 'drizzle-orm';

// Export/upload repeat per service. They share a phase; artifact initialization
// and completion still delimit that loop so delayed receipts cannot rewind it.
const PHASES: Record<string, number> = {
  queued: 0,
  collecting: 1,
  context_ready: 2,
  starting: 3,
  validating: 4,
  building: 5,
  exporting: 6,
  uploading: 6,
  recording_release: 7,
};
const STEPS: Record<string, number> = {
  queued: 0,
  collecting: 1,
  context_ready: 2,
  accepted: 3,
  started: 3,
  builder_start: 3,
  builder_ready: 3,
  compose_config: 4,
  compose_build: 5,
  artifact_init: 6,
  docker_save: 7,
  upload_archive: 7,
  artifact_complete: 8,
  release_submission: 9,
};
function rank(
  column: SQL | typeof schema.deploymentPublishJobs.status,
  phases: Record<string, number>
) {
  return sql`CASE ${column} ${sql.join(
    Object.entries(phases).map(([name, phase]) => sql`WHEN ${name} THEN ${phase}`),
    sql` `
  )} ELSE -1 END`;
}

/** Evaluated with history and the final UPDATE, never a preceding SELECT.
 * Legacy node executors and phase-2 shadows retain their existing protocol.
 * Only verified context completion and atomic admission may bypass this helper.
 */
export function publishJobTransitionPredicate(
  status?: string,
  step?: string | null,
  terminal = false
) {
  if (terminal || (!status && step === undefined)) return undefined;
  const j = schema.deploymentPublishJobs;
  return or(
    ne(j.executor, 'cloudflare'),
    eq(j.contextShadow, true),
    and(
      status
        ? !Object.hasOwn(PHASES, status)
          ? sql`0`
          : sql`${rank(j.status, PHASES)} <= ${PHASES[status]}`
        : undefined,
      step === null
        ? sql`0`
        : step
          ? !Object.hasOwn(STEPS, step)
            ? eq(j.currentStep, step)
            : sql`${rank(sql`${j.currentStep}`, STEPS)} <= ${STEPS[step]}`
          : undefined
    )
  );
}
