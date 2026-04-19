/**
 * TrialOrchestrator helper passthroughs.
 *
 * Backoff/transient-error detection is identical to the TaskRunner pattern, so
 * we re-export those helpers rather than duplicating. Anything trial-specific
 * (event emission helpers, project-row creation) lives in steps.ts.
 */
export {
  computeBackoffMs,
  isTransientError,
  parseEnvInt,
} from '../task-runner/helpers';

import type { TrialEvent } from '@simple-agent-manager/shared';
import { TRIAL_ANONYMOUS_USER_ID } from '@simple-agent-manager/shared';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { emitTrialEvent } from '../../services/trial/trial-runner';

/**
 * Sentinel userId used for every anonymous trial project/workspace.
 *
 * Security note: ALL in-flight trials share the same owning userId. This is
 * intentional (we have no real user until `/claim` succeeds), but it means any
 * per-user query scope (e.g., `WHERE userId = ?`) does NOT isolate one trial
 * from another. Downstream code that acts on trial-owned rows MUST additionally
 * scope by `projectId` (or trialId) to prevent one trial's logic from observing
 * or mutating another trial's state. Platform-level IDOR enforcement lives in
 * `requireOwnedProject` (`apps/api/src/middleware/require-owned-project.ts`)
 * and is not bypassed by trial code — but trial-internal loops (e.g.,
 * `handleNodeSelection` scanning all sentinel-owned nodes) rely on the D1
 * query filtering by projectId/nodeId where applicable.
 */
export function resolveAnonymousUserId(env: Env): string {
  return env.TRIAL_ANONYMOUS_USER_ID ?? TRIAL_ANONYMOUS_USER_ID;
}

/**
 * Sentinel GitHub installation id that trial projects FK into. Operators can
 * override via `TRIAL_ANONYMOUS_INSTALLATION_ID`; the default value matches
 * the row seeded by migration `0045_trial_sentinel_installation.sql`.
 */
export const DEFAULT_TRIAL_ANONYMOUS_INSTALLATION_ID =
  'system_anonymous_trials_installation';

export function resolveAnonymousInstallationId(env: Env): string {
  return env.TRIAL_ANONYMOUS_INSTALLATION_ID ?? DEFAULT_TRIAL_ANONYMOUS_INSTALLATION_ID;
}

/**
 * Fire-and-forget trial event emit. Wraps `emitTrialEvent` in a catch so a
 * failing event bus never blocks the state machine — alarms drive progress.
 */
export async function safeEmitTrialEvent(
  env: Env,
  trialId: string,
  event: TrialEvent
): Promise<void> {
  try {
    await emitTrialEvent(env, trialId, event);
  } catch (err) {
    log.warn('trial_orchestrator.emit_event_failed', {
      trialId,
      type: event.type,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
