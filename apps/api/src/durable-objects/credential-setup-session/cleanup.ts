/**
 * Sandbox and pool cleanup for a setup session whose terminal status teardown has
 * already claimed (CredentialSetupSession.teardown in ./index.ts).
 *
 * Every step is best-effort (logged, never thrown) and safe to repeat, because the
 * recovery alarm re-runs the cleanup when an isolate dies part-way through it.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import type { SetupSessionStatus } from '../../services/credential-setup-config';
import {
  destroySandboxInstance,
  getSandboxConfig,
  getSandboxInstance,
  shellQuote,
  withTimeout,
} from '../../services/sandbox';
import { releaseSetupSlot } from '../../services/setup-session-pool';
import { updateSetupSessionD1Status } from './d1-status';
import type { SetupSessionRow } from './schema';

export interface SetupSessionCleanupContext {
  env: Env;
  sql: SqlStorage;
  /** Disarm the recovery alarm once the cleanup has finished. */
  deleteAlarm(): Promise<void>;
}

type ScrubSkipReason = 'never_left_provisioning' | 'resumed_after_interruption';

/**
 * Why the setup-dir scrub is skipped, or null to run it.
 * - `never_left_provisioning`: no driver ran and no sign-in URL was shown, so no
 *   credential can exist; an exec would start a container that never started and wait
 *   out the SDK's start retries before the destroy could run.
 * - `resumed_after_interruption`: the isolate died mid-cleanup, so whether the container
 *   survived is unknown, and an exec would start a fresh, empty one only to scrub it.
 * In both cases the destroy (step 2) still removes the container's filesystem.
 */
function scrubSkipReason(row: SetupSessionRow, resumed: boolean): ScrubSkipReason | null {
  if (row.cleanup_from_status === 'provisioning') return 'never_left_provisioning';
  if (resumed) return 'resumed_after_interruption';
  return null;
}

export async function runSetupSessionCleanup(
  context: SetupSessionCleanupContext,
  row: SetupSessionRow,
  resumed: boolean
): Promise<void> {
  const { env, sql } = context;
  const execTimeoutMs = getSandboxConfig(env).execTimeoutMs;

  // 1. Delete the captured credential file and scrub the setup dir.
  const skipScrub = scrubSkipReason(row, resumed);
  if (skipScrub) {
    log.info('credential_setup.scrub_skipped', { sessionId: row.id, reason: skipScrub });
  } else {
    try {
      const sandbox = await getSandboxInstance(env, row.id);
      // Variable (not inline): avoids the SQL-injection AST check's false positive.
      const scrubCmd = `rm -rf ${shellQuote(row.codex_home)}`;
      // Bounded here too: the exec's own timeout covers the command, not the container
      // start the SDK may perform before it.
      await withTimeout(
        sandbox.exec(scrubCmd, { timeout: execTimeoutMs }),
        execTimeoutMs,
        `Setup dir scrub timed out after ${execTimeoutMs}ms`
      );
    } catch (err) {
      log.warn('credential_setup.scrub_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // 2. Destroy the sandbox container (bounded inside destroySandboxInstance).
  try {
    await destroySandboxInstance(env, row.id, { sandboxId: row.id });
  } catch (err) {
    log.warn('credential_setup.sandbox_destroy_failed', {
      sessionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // 3. Release the concurrency slot (idempotent in the pool DO).
  try {
    await releaseSetupSlot(env, row.pool_lease_id);
  } catch (err) {
    log.warn('credential_setup.pool_release_failed', {
      sessionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // 4. Repair D1 only if teardown's terminal write did not land (that write logs and
  //    continues on failure). A no-op when D1 is already terminal.
  await updateSetupSessionD1Status(env, row.id, row.status as SetupSessionStatus, {
    errorCode: row.error_code ?? undefined,
    errorMessage: row.error_message ?? undefined,
    completed: true,
    onlyIfActive: true,
  });
  // 5. Cleanup is done: clear the marker, then the recovery alarm.
  sql.exec(`UPDATE setup_session SET cleanup_pending = 0 WHERE id = ?`, row.id);
  await context.deleteAlarm();
  log.info('credential_setup.torn_down', {
    sessionId: row.id,
    finalStatus: row.status,
    errorCode: row.error_code,
    cleanupFromStatus: row.cleanup_from_status,
    resumed,
  });
}
