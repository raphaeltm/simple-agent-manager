/**
 * Deploy steps in words, from the apply events a deployment server reports
 * (`GET …/releases/:releaseId/events`, written by `packages/vm-agent/internal/deploy/engine.go`).
 *
 * Each step sends `deployment.apply.<prefix>_started` and, when it finishes, `…_completed`
 * (some `…_verified`). A step with nothing to do sends only `…_skipped` (`compose_pull` when
 * the images were loaded from the release), and is left out. The `step` field is the key below; the event
 * prefix can differ from it (`artifacts_load` reports step `load_artifacts`). A failure
 * arrives as one `deployment.apply.failed` (or `failed_initial`) event, so the failed step
 * is the one that started and never finished. Putting the previous version back sends
 * `revert_started` and, only if that works, `deployment.apply.reverted`; a failed revert
 * sends nothing more.
 */
import type { DeploymentReleaseEvent } from '../../lib/api';

/** [done, in progress, failed] wording for each step key the agent reports. */
export const STEP_NAMES: Record<string, [string, string, string]> = {
  fetch_release: [
    'Got the new version',
    'Getting the new version…',
    "Couldn't get the new version",
  ],
  previous_down: [
    'Stopped the old version',
    'Stopping the old version…',
    "Couldn't stop the old version",
  ],
  registry_login: [
    'Signed in to the image registry',
    'Signing in to the image registry…',
    "Couldn't sign in to the image registry",
  ],
  volume_mounts: [
    'Attached the saved data',
    'Attaching the saved data…',
    "Couldn't attach the saved data",
  ],
  load_artifacts: ['Loaded the images', 'Loading the images…', "Couldn't load the images"],
  compose_config: [
    "Checked the app's setup",
    "Checking the app's setup…",
    "The app's setup has a mistake",
  ],
  compose_pull: ['Pulled the images', 'Pulling the images…', "Couldn't pull the images"],
  compose_up: ['Started the app', 'Starting the app…', "The app didn't start"],
  health_check: ['Passed its health check', 'Checking the app answers…', 'Failed its health check'],
  caddy_reload: [
    'Pointed the addresses at it',
    'Pointing the addresses at it…',
    "Couldn't point the addresses at it",
  ],
  revert: [
    'Put the previous version back',
    'Putting the previous version back…',
    "Couldn't put the previous version back",
  ],
  // A failure in a step with no events of its own (writing or saving the release state).
  other: ['', '', 'Stopped partway'],
};

export type StepState = 'done' | 'running' | 'failed';

const FINISHED = /_(completed|skipped|verified)$/;
const SKIPPED = /_skipped$/;
const FAILED = new Set(['deployment.apply.failed', 'deployment.apply.failed_initial']);
/** Events that open an attempt before `deployment.apply.started`. */
const PRELUDE = new Set([
  'deployment.apply.fetch_started',
  'deployment.apply.fetch_completed',
  'deployment.apply.payload_verified',
]);

/**
 * The events of the newest attempt. A Start or an agent restart applies the same release
 * again, and its events append to the same history, so older attempts must not mix in.
 */
export function latestAttempt(events: DeploymentReleaseEvent[]): DeploymentReleaseEvent[] {
  const types = events.map((event) => event.eventType);
  const lastFetch = types.lastIndexOf('deployment.apply.fetch_started');
  const lastApply = types.lastIndexOf('deployment.apply.started');
  if (lastFetch > lastApply) return events.slice(lastFetch);
  if (lastApply === -1) return events;
  let start = lastApply;
  while (start > 0 && PRELUDE.has(types[start - 1] ?? '')) start -= 1;
  return events.slice(start);
}

/**
 * One row per step of the newest attempt, in the order the server reported them. `over`
 * means the apply has ended, so a revert that never reported `reverted` failed, and a step
 * that never finished did not, after all, get there.
 */
export function collapseSteps(
  events: DeploymentReleaseEvent[],
  over: boolean
): Array<{ step: string; state: StepState }> {
  const order: string[] = [];
  const done = new Set<string>();
  let failedAt: number | null = null;
  for (const event of latestAttempt(events)) {
    if (FAILED.has(event.eventType)) {
      failedAt ??= order.length;
      continue;
    }
    const step = event.step;
    if (!step || step === 'other' || !STEP_NAMES[step]) continue;
    // A step the server skipped did nothing: listing it as done would say it happened.
    if (SKIPPED.test(event.eventType) && !order.includes(step)) continue;
    if (!order.includes(step)) order.push(step);
    if (FINISHED.test(event.eventType) || event.eventType === 'deployment.apply.reverted')
      done.add(step);
    // A failed teardown of the old version is only a warning: the apply carries on.
    if (event.eventType === 'deployment.apply.previous_down_failed') done.add(step);
  }
  const rows = order.map((step, index): { step: string; state: StepState } => {
    if (done.has(step)) return { step, state: 'done' };
    if (step === 'revert') return { step, state: over ? 'failed' : 'running' };
    if (failedAt !== null) return { step, state: index < failedAt ? 'failed' : 'running' };
    return { step, state: over ? 'failed' : 'running' };
  });
  // The failure came from a step with no events of its own: say where it stopped.
  if (failedAt !== null && !rows.slice(0, failedAt).some((row) => row.state === 'failed')) {
    rows.splice(failedAt, 0, { step: 'other', state: 'failed' });
  }
  return rows;
}

export function stepLabel(step: string, state: StepState): string {
  return STEP_NAMES[step]?.[state === 'done' ? 0 : state === 'running' ? 1 : 2] ?? step;
}
