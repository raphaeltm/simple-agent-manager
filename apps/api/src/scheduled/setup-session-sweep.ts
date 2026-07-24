/**
 * Cron sweep for expired guided credential-setup sessions.
 *
 * Backstop to the per-session DO expiry alarm: if a browser vanishes and the
 * DO alarm didn't fire (or the DO was never fully created), this bounded sweep
 * tears the session down and — crucially — force-terminalizes the D1 row and
 * releases its pool slot so every selected candidate leaves the candidate set
 * (rule 47: no immortal candidates, bounded per-run cost).
 */
import {
  ACTIVE_SETUP_STATUSES,
  getSetupSessionSweepMaxCandidates,
} from '../services/credential-setup-config';
import { cancelSetupSession } from '../services/credential-setup-session';
import { releaseSetupSlot } from '../services/setup-session-pool';
import type { Env } from '../env';
import { log } from '../lib/logger';

export interface SetupSessionSweepResult {
  candidates: number;
  toreDown: number;
  orphansForced: number;
  errors: number;
}

export async function runSetupSessionSweep(env: Env): Promise<SetupSessionSweepResult> {
  const result: SetupSessionSweepResult = { candidates: 0, toreDown: 0, orphansForced: 0, errors: 0 };
  // No DO namespace bound (e.g. local/miniflare without the binding) — nothing to do.
  if (!env.CREDENTIAL_SETUP_SESSION) return result;

  const nowIso = new Date().toISOString();
  const limit = getSetupSessionSweepMaxCandidates(env);
  const placeholders = ACTIVE_SETUP_STATUSES.map(() => '?').join(', ');

  const rows = await env.DATABASE.prepare(
    `SELECT id, pool_lease_id FROM agent_credential_setup_sessions
     WHERE status IN (${placeholders}) AND expires_at < ?
     ORDER BY expires_at ASC LIMIT ?`
  )
    .bind(...ACTIVE_SETUP_STATUSES, nowIso, limit)
    .all<{ id: string; pool_lease_id: string | null }>();

  const candidates = rows.results ?? [];
  result.candidates = candidates.length;

  for (const row of candidates) {
    try {
      // Preferred path: the DO tears itself down (scrub, destroy sandbox, release).
      await cancelSetupSession(env, row.id);
      result.toreDown++;
    } catch (err) {
      result.errors++;
      log.warn('setup_session_sweep.teardown_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }

    // Escape-path guarantee: if the DO couldn't terminalize the row (e.g. it was
    // never created), force the D1 row to a terminal state and free its slot so
    // the next sweep does not re-select it (two-run zombie prevention).
    try {
      const forced = await env.DATABASE.prepare(
        `UPDATE agent_credential_setup_sessions
         SET status = 'expired', error_code = 'swept',
             error_message = 'Expired setup session reclaimed by sweep',
             completed_at = ?, updated_at = ?
         WHERE id = ? AND status IN (${placeholders})`
      )
        .bind(nowIso, nowIso, row.id, ...ACTIVE_SETUP_STATUSES)
        .run();
      if ((forced.meta?.changes ?? 0) > 0) {
        result.orphansForced++;
        await releaseSetupSlot(env, row.pool_lease_id); // idempotent
      }
    } catch (err) {
      result.errors++;
      log.warn('setup_session_sweep.force_terminal_failed', {
        sessionId: row.id,
        error: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return result;
}
