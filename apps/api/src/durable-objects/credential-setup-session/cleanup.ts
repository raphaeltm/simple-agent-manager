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
import { readCleanupRow } from './cleanup-recovery';
import { updateSetupSessionD1Status } from './d1-status';
import { beginSandboxFlight } from './lifecycle-io';
import type { SetupSessionRow } from './schema';

export interface SetupSessionCleanupContext {
  env: Env;
  sql: SqlStorage;
  deferPending(row: SetupSessionRow): Promise<boolean>;
  claimAttempt(row: SetupSessionRow): Promise<boolean>;
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
  // Recovery has its snapshotted attempt cap and four bounded remote steps (20s
  // per attempt by default), plus the settings read. Inline keeps its existing budget.
  const execTimeoutMs = resumed
    ? Math.min(interactiveTimeoutMs, await getSetupSessionCleanupRecoveryStepTimeoutMs(env))
    : interactiveTimeoutMs;
  // Repair first, including while SDK uncertainty prevents destructive cleanup.
  const d1Repaired = await repairTerminalD1(env, row, resumed, execTimeoutMs);
  row = readCleanupRow(sql, row.id) ?? row;
  if (await context.deferPending(row)) return;
  if (resumed && !(await context.claimAttempt(row))) return;
  if (skipsScrub(row, resumed)) {
    log.info('credential_setup.scrub_skipped', { sessionId: row.id, reason: scrubSkipReason(row) });
  } else {
    await scrubSetupDirectory(context, row, execTimeoutMs);
  }
  if (await context.deferPending(row)) return;
  const destroyed = await destroySetupSandbox(context, row, execTimeoutMs);
  if (await context.deferPending(row)) return;
  const released = await releaseSetupPool(env, row, resumed, execTimeoutMs);
  // Failed/unfinished steps preserve both the obligation and a future recovery alarm.
  if (!destroyed || !released || !d1Repaired) {
    await context.rearmAlarm();
    return;
  }
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

function scrubSkipReason(row: SetupSessionRow): string {
  if (row.cleanup_scrub_state === 2) return 'scrub_already_succeeded';
  if (row.cleanup_sandbox_destroyed === 1) return 'sandbox_already_destroyed';
  return 'never_left_provisioning';
}

async function repairTerminalD1(
  env: Env,
  row: SetupSessionRow,
  resumed: boolean,
  execTimeoutMs: number
): Promise<boolean> {
  try {
    const repair = updateSetupSessionD1Status(env, row.id, row.status as SetupSessionStatus, {
      errorCode: row.error_code ?? undefined,
      errorMessage: row.error_message ?? undefined,
      completed: true,
      onlyIfActive: true,
    });
    return resumed
      ? await withTimeout(repair, execTimeoutMs, 'Setup D1 repair timed out')
      : await repair;
  } catch {
    log.warn('credential_setup.d1_repair_timeout', { sessionId: row.id });
    return false;
  }
}

async function scrubSetupDirectory(
  context: SetupSessionCleanupContext,
  row: SetupSessionRow,
  execTimeoutMs: number
): Promise<void> {
  const { env, sql } = context;
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
            const succeeded = result.success === true && result.exitCode === 0;
            await recordScrubSettled(context, row.id, succeeded, () => settled(!scrubAllowed));
            if (!succeeded)
              log.warn('credential_setup.scrub_failed', {
                sessionId: row.id,
                reason: 'command_unsuccessful',
              });
            return result;
          },
          async (error: unknown) => {
            await recordScrubSettled(context, row.id, false, () => settled(!scrubAllowed));
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

async function destroySetupSandbox(
  context: SetupSessionCleanupContext,
  row: SetupSessionRow,
  execTimeoutMs: number
): Promise<boolean> {
  if (row.cleanup_sandbox_destroyed === 1) return true;
  const { env, sql } = context;
  let awaitingDestruction = true;
  try {
    const settled = beginSandboxFlight(sql, row.id, () => context.rearmAlarm());
    const destruction = Promise.resolve()
      .then(() => destroySandboxInstance(env, row.id, { sandboxId: row.id }, { timeoutMs: null }))
      .then(
        async () => {
          // Commit before settlement/rearm so recovery never recreates this sandbox.
          // If proof cannot persist, retain uncertainty instead of permitting exec.
          try {
            sql.exec(`UPDATE setup_session SET cleanup_sandbox_destroyed = 1 WHERE id = ?`, row.id);
          } catch {
            log.error('credential_setup.destroy_proof_failed', { sessionId: row.id });
            throw new Error('Setup destruction proof could not be persisted');
          }
          await settled(!awaitingDestruction);
        },
        async (error: unknown) => {
          await settled(!awaitingDestruction);
          throw error;
        }
      );
    context.waitUntil(
      destruction.then(
        () => undefined,
        () => undefined
      )
    );
    await withTimeout(
      destruction,
      execTimeoutMs,
      `Setup sandbox destroy timed out after ${execTimeoutMs}ms`
    );
    return true;
  } catch {
    log.warn('credential_setup.sandbox_destroy_failed', { sessionId: row.id });
    return false;
  } finally {
    awaitingDestruction = false;
  }
}

async function releaseSetupPool(
  env: Env,
  row: SetupSessionRow,
  resumed: boolean,
  execTimeoutMs: number
): Promise<boolean> {
  try {
    const release = releaseSetupSlot(env, row.pool_lease_id);
    if (resumed) await withTimeout(release, execTimeoutMs, 'Setup pool release timed out');
    else await release;
    return true;
  } catch (err) {
    log.warn('credential_setup.pool_release_failed', {
      sessionId: row.id,
      error: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

/** Only a successful command proves scrubbing; settlement alone clears uncertainty. */
async function recordScrubSettled(
  context: SetupSessionCleanupContext,
  sessionId: string,
  succeeded: boolean,
  settleFlight: () => Promise<void>
): Promise<void> {
  try {
    context.sql.exec(
      `UPDATE setup_session SET cleanup_scrub_state = ? WHERE id = ? AND cleanup_scrub_state = 1`,
      succeeded ? 2 : null,
      sessionId
    );
    await settleFlight();
  } catch {
    log.error('credential_setup.scrub_settlement_failed', { sessionId });
  }
}
