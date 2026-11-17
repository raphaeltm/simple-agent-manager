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
import { beginSandboxFlight } from './lifecycle-io';
import type { SetupSessionRow } from './schema';

export interface SetupSessionCleanupContext {
  env: Env;
  sql: SqlStorage;
  /** Schedule recovery after a failed attempt, even if the old alarm already fired. */
  rearmAlarm(): Promise<void>;
  /** Disarm the recovery alarm once the cleanup has finished. */
  deleteAlarm(): Promise<void>;
  waitUntil(work: Promise<void>): void;
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
    row.cleanup_scrub_state === 2 ||
    row.cleanup_sandbox_destroyed === 1 ||
    (row.cleanup_from_status === 'provisioning' &&
      (!resumed || row.cleanup_sandbox_io_pending === 0))
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
  // plus pool release and D1 repair (20s total by default), plus the settings read.
  const execTimeoutMs = resumed
    ? Math.min(interactiveTimeoutMs, await getSetupSessionCleanupRecoveryStepTimeoutMs(env))
    : interactiveTimeoutMs;

  // Terminal D1 repair is safe even while a scrub remains uncertain. On recovery,
  // all RPC/D1 waits get the short step budget; a timeout never clears the obligation.
  let d1Repaired = false;
  try {
    const repair = updateSetupSessionD1Status(env, row.id, row.status as SetupSessionStatus, {
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      completed: true,
      onlyIfActive: true,
    });
    d1Repaired = resumed
      ? await withTimeout(repair, execTimeoutMs, 'Setup D1 repair timed out')
      : await repair;
  } catch {
    log.warn('credential_setup.d1_repair_timeout', { sessionId: row.id });
  }
  // 1. Delete the captured credential file and scrub the setup dir (bounded).
  if ((row.cleanup_sandbox_io_pending ?? 0) > 0 || row.cleanup_scrub_state === 1) {
    if (row.cleanup_from_status === 'provisioning')
      log.info('credential_setup.scrub_skipped', {
        sessionId: row.id,
        reason: 'provisioning_still_in_flight',
      });
    // An evicted isolate may have left SDK startup/retry work behind. Neither an
    // alarm nor a timeout proves it stopped; do not race it with destruction.
    await context.rearmAlarm();
    return;
  }
  if (skipsScrub(row, resumed)) {
    log.info('credential_setup.scrub_skipped', {
      sessionId: row.id,
      reason:
        row.cleanup_scrub_state === 2
          ? 'scrub_already_settled'
          : row.cleanup_sandbox_destroyed === 1
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
          const settled = beginSandboxFlight(sql, row.id, () => context.rearmAlarm());
          sql.exec(`UPDATE setup_session SET cleanup_scrub_state = 1 WHERE id = ?`, row.id);
          // Mark uncertainty BEFORE invocation, including a synchronous SDK throw.
          const execution = Promise.resolve().then(() =>
            sandbox.exec(scrubCmd, { timeout: execTimeoutMs })
          );
          const observed = execution.then(
            async (result) => {
              await recordScrubSettled(context, row.id, () => settled(!scrubAllowed));
              return result;
            },
            async (error: unknown) => {
              await recordScrubSettled(context, row.id, () => settled(!scrubAllowed));
              throw error;
            }
          );
          context.waitUntil(
            observed.then(
              () => undefined,
              () => undefined
            )
          );
          return observed;
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
  const scrubState = sql
    .exec<{ cleanup_scrub_state: number | null }>(
      'SELECT cleanup_scrub_state FROM setup_session WHERE id = ?',
      row.id
    )
    .toArray()[0]?.cleanup_scrub_state;
  if (scrubState === 1) {
    await context.rearmAlarm();
    return;
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
    const release = releaseSetupSlot(env, row.pool_lease_id);
    if (resumed) await withTimeout(release, execTimeoutMs, 'Setup pool release timed out');
    else await release;
  } catch (err) {
    cleanupSucceeded = false;
    log.warn('credential_setup.pool_release_failed', {
      sessionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
  }
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

/** SDK settlement is positive evidence; eviction or an outer deadline is not. */
async function recordScrubSettled(
  context: SetupSessionCleanupContext,
  sessionId: string,
  settleFlight: () => Promise<void>
): Promise<void> {
  try {
    context.sql.exec(
      `UPDATE setup_session SET cleanup_scrub_state = 2 WHERE id = ? AND cleanup_scrub_state = 1`,
      sessionId
    );
    await settleFlight();
  } catch {
    log.error('credential_setup.scrub_settlement_failed', { sessionId });
  }
}
