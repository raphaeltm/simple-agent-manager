/** Shared flight settlement: elapsed time and isolate eviction never prove SDK work stopped. */
import * as v from 'valibot';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getSandboxConfig, getSandboxInstance, shellQuote } from '../../services/sandbox';
import { cleanupAttemptLimit } from './cleanup-recovery';
import { type DeviceAuthState, DeviceAuthStateSchema } from './driver-state';
import type { SetupSessionRow } from './schema';

export async function rearmPendingCleanup(
  sql: SqlStorage,
  sessionId: string,
  rearm: () => Promise<void>
): Promise<void> {
  const current = sql
    .exec<SetupSessionRow>('SELECT * FROM setup_session WHERE id = ?', sessionId)
    .toArray()[0];
  if (
    current?.cleanup_pending === 1 &&
    (current.cleanup_attempts ?? 0) <= cleanupAttemptLimit(current)
  )
    await rearm();
}

/** One counter unit belongs to one original promise chain, never to a later alarm. */
export function beginSandboxFlight(
  sql: SqlStorage,
  sessionId: string,
  rearm: () => Promise<void>
): (needsRearm?: boolean) => Promise<void> {
  sql.exec(
    `UPDATE setup_session SET cleanup_sandbox_io_pending = COALESCE(cleanup_sandbox_io_pending, 0) + 1 WHERE id = ?`,
    sessionId
  );
  let settled = false;
  return async (needsRearm = true) => {
    if (settled) return;
    settled = true;
    try {
      sql.exec(
        `UPDATE setup_session SET cleanup_sandbox_io_pending = MAX(0, COALESCE(cleanup_sandbox_io_pending, 0) - 1) WHERE id = ?`,
        sessionId
      );
      if (needsRearm) await rearmPendingCleanup(sql, sessionId, rearm);
    } catch {
      log.error('credential_setup.sdk_settlement_failed', { sessionId });
    }
  };
}

export function trackSandboxFlight<T>(
  sql: SqlStorage,
  ctx: DurableObjectState,
  sessionId: string,
  rearm: () => Promise<void>,
  run: () => Promise<T>
): Promise<T> {
  const settled = beginSandboxFlight(sql, sessionId, rearm);
  const flight = (async () => {
    try {
      return await run();
    } finally {
      await settled();
    }
  })();
  ctx.waitUntil(
    flight.then(
      () => undefined,
      () => undefined
    )
  );
  return flight;
}

/** Reads are SDK producers too: a late readFile can restart a destroyed sandbox. */
export async function readDeviceAuthState(
  env: Env,
  row: SetupSessionRow,
  isActive: () => boolean,
  path: string
): Promise<DeviceAuthState | null> {
  try {
    if (!isActive()) return null;
    const sandbox = await getSandboxInstance(env, row.id);
    if (!isActive()) return null;
    const existence = await sandbox.exists(path);
    if (!isActive() || !existence.exists) return null;
    const file = await sandbox.readFile(path);
    if (!isActive()) return null;
    const raw = JSON.parse(file.content ?? '') as unknown;
    const result = v.safeParse(DeviceAuthStateSchema, raw);
    return result.success ? result.output : null;
  } catch {
    return null;
  }
}

/** Check authoritative cancellation after every awaited SDK call, before issuing another. */
export async function runProvisioningSandboxSteps(
  env: Env,
  row: SetupSessionRow,
  isCurrent: () => boolean,
  startCommand: string
): Promise<boolean> {
  const sandbox = await getSandboxInstance(env, row.id);
  if (!isCurrent()) return false;
  const mkdirCmd = `mkdir -p ${shellQuote(row.codex_home)}`;
  await sandbox.exec(mkdirCmd, { timeout: getSandboxConfig(env).execTimeoutMs });
  if (!isCurrent()) return false;
  if (row.agent_type === 'openai-codex') {
    await sandbox.writeFile(
      `${row.codex_home}/config.toml`,
      'cli_auth_credentials_store = "file"\n'
    );
    if (!isCurrent()) return false;
  }
  await sandbox.exec(startCommand, { timeout: getSandboxConfig(env).execTimeoutMs });
  return isCurrent();
}

/** Failure to schedule recovery must not block D1 terminalization or inline cleanup. */
export async function armCleanupAlarmBestEffort(
  ctx: DurableObjectState,
  row: SetupSessionRow,
  required = false
): Promise<void> {
  try {
    await ctx.storage.setAlarm(Date.now() + row.capture_poll_ms);
  } catch {
    log.error('credential_setup.cleanup_alarm_failed', { sessionId: row.id });
    if (required) throw new Error('Credential setup cleanup alarm could not be scheduled');
  }
}
