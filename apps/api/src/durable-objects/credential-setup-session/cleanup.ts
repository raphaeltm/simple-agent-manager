/**
 * Sandbox and pool cleanup for a setup session whose terminal status teardown has
 * already claimed (CredentialSetupSession.teardown in ./index.ts).
 *
 * Every step is best-effort (logged, never thrown) and safe to repeat, because the
 * recovery alarm re-runs interrupted or failed cleanup up to its recovery cap.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  getSetupSessionCleanupRecoveryStepTimeoutMs,
  type SetupSessionStatus,
} from '../../services/credential-setup-config';
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
  /** Schedule recovery after a failed attempt, even if the old alarm already fired. */
  rearmAlarm(): Promise<void>;
  /** Disarm the recovery alarm once the cleanup has finished. */
  deleteAlarm(): Promise<void>;
}

/**
 * The initial scrub is skipped when teardown started from `provisioning`: an exec
 * could start a container that never started and wait out the SDK's start retries
 * before the destroy.
 * A resumed cleanup scrubs unless destruction was durably confirmed: the Sandbox
 * container outlives the dead DO isolate, so the captured credential may still be
 * on it, and the destroy
 * after the scrub is best-effort. (The integration branch also skipped it on resume,
 * because on celld the exec starts a fresh container; that is self-host only.)
 */
function skipsScrub(row: SetupSessionRow, resumed: boolean): boolean {
  return (
    row.cleanup_sandbox_destroyed === 1 || (!resumed && row.cleanup_from_status === 'provisioning')
  );
}

export async function runSetupSessionCleanup(
  context: SetupSessionCleanupContext,
  row: SetupSessionRow,
  resumed: boolean
): Promise<void> {
  const { env, sql } = context;
  const interactiveTimeoutMs = getSandboxConfig(env).execTimeoutMs;
  // Recovery is a control loop: at most three attempts, two bounded sandbox steps
  // per attempt (10s total by default), plus settings/pool/D1 bookkeeping.
  const execTimeoutMs = resumed
    ? Math.min(interactiveTimeoutMs, await getSetupSessionCleanupRecoveryStepTimeoutMs(env))
    : interactiveTimeoutMs;

  // 1. Delete the captured credential file and scrub the setup dir (bounded).
  if (skipsScrub(row, resumed)) {
    log.info('credential_setup.scrub_skipped', {
      sessionId: row.id,
      reason:
        row.cleanup_sandbox_destroyed === 1
          ? 'sandbox_already_destroyed'
          : 'never_left_provisioning',
    });
  } else {
    let scrubAllowed = true;
    try {
      // Variable (not inline): avoids the SQL-injection AST check's false positive.
      const scrubCmd = `rm -rf ${shellQuote(row.codex_home)}`;
      // Bounded here too: the exec's own timeout covers the command, not the container
      // start the SDK may perform before it.
      await withTimeout(
        (async () => {
          const sandbox = await getSandboxInstance(env, row.id);
          // A timed-out acquisition can resolve after destruction. Do not begin
          // a new exec then: it would restart the sandbox we just removed.
          if (!scrubAllowed) return;
          return sandbox.exec(scrubCmd, { timeout: execTimeoutMs });
        })(),
        execTimeoutMs,
        `Setup dir scrub timed out after ${execTimeoutMs}ms`
      );
    } catch (err) {
      log.warn('credential_setup.scrub_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    } finally {
      scrubAllowed = false;
    }
  }
  let cleanupSucceeded = true;
  // 2. Destroy the sandbox container (bounded inside destroySandboxInstance).
  if (row.cleanup_sandbox_destroyed !== 1) {
    try {
      const destruction = destroySandboxInstance(env, row.id, { sandboxId: row.id });
      if (resumed) {
        await withTimeout(
          destruction,
          execTimeoutMs,
          `Setup sandbox destroy timed out after ${execTimeoutMs}ms`
        );
      } else {
        await destruction;
      }
      // Commit proof before the next await: a death during pool/D1 cleanup must
      // never make recovery exec against (and recreate) the destroyed sandbox.
      sql.exec(`UPDATE setup_session SET cleanup_sandbox_destroyed = 1 WHERE id = ?`, row.id);
    } catch (err) {
      cleanupSucceeded = false;
      log.warn('credential_setup.sandbox_destroy_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }
  // 3. Release the concurrency slot (idempotent in the pool DO).
  try {
    await releaseSetupSlot(env, row.pool_lease_id);
  } catch (err) {
    cleanupSucceeded = false;
    log.warn('credential_setup.pool_release_failed', {
      sessionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
  // 4. Repair D1 only if teardown's terminal write did not land (that write logs and
  //    continues on failure). A no-op when D1 is already terminal.
  const d1Repaired = await updateSetupSessionD1Status(
    env,
    row.id,
    row.status as SetupSessionStatus,
    {
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      completed: true,
      onlyIfActive: true,
    }
  );
  // A successful destroy makes a failed scrub harmless. Destroy, pool release and
  // D1 repair are required: keep the durable marker and re-arm recovery if any
  // failed, rather than declaring a best-effort attempt complete.
  if (!cleanupSucceeded || !d1Repaired) {
    // The old alarm may have fired and joined this attempt while sandbox I/O was
    // in flight. A future alarm must be armed after failure, not only before I/O.
    await context.rearmAlarm();
    return;
  }
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
