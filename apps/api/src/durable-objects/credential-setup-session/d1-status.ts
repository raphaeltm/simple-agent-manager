/**
 * The D1 mirror of a setup session's status (`agent_credential_setup_sessions`).
 * The create route's one-active lookup and the status route read it, so every
 * lifecycle transition the DO makes is written here too. Failures are logged and
 * swallowed: the DO's own SQLite stays authoritative, and teardown repairs D1.
 */
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import {
  ACTIVE_SETUP_STATUSES,
  type SetupSessionStatus,
} from '../../services/credential-setup-config';

export interface SetupSessionD1Extra {
  errorCode?: string;
  errorMessage?: string;
  completed?: boolean;
  started?: boolean;
  /** Only write while the D1 row is still active: a repair, never an overwrite. */
  onlyIfActive?: boolean;
}

export async function updateSetupSessionD1Status(
  env: Env,
  id: string,
  status: SetupSessionStatus,
  extra?: SetupSessionD1Extra
): Promise<void> {
  const now = new Date().toISOString();
  const set = ['status = ?', 'updated_at = ?'];
  const binds: unknown[] = [status, now];
  if (extra?.started) {
    set.push('started_at = COALESCE(started_at, ?)');
    binds.push(now);
  }
  if (extra?.completed) {
    set.push('completed_at = ?');
    binds.push(now);
  }
  if (extra?.errorCode !== undefined) {
    set.push('error_code = ?');
    binds.push(extra.errorCode);
  }
  if (extra?.errorMessage !== undefined) {
    set.push('error_message = ?');
    binds.push(extra.errorMessage);
  }
  binds.push(id);
  let where = 'id = ?';
  if (extra?.onlyIfActive) {
    where += ` AND status IN (${ACTIVE_SETUP_STATUSES.map(() => '?').join(', ')})`;
    binds.push(...ACTIVE_SETUP_STATUSES);
  }
  try {
    await env.DATABASE.prepare(
      `UPDATE agent_credential_setup_sessions SET ${set.join(', ')} WHERE ${where}`
    )
      .bind(...binds)
      .run();
  } catch (err) {
    log.warn('credential_setup.d1_update_failed', {
      sessionId: id,
      status,
      error: err instanceof Error ? err.message : String(err),
    });
  }
}
