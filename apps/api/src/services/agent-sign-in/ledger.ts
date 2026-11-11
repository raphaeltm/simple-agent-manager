/**
 * The agent sign-in ledger (`agent_sign_ins`, migration 0234): audit record, replay guard and
 * per-principal rate limit in one table.
 *
 * `claimAgentSignIn` is a single guarded INSERT. SQLite serializes it, so two requests carrying
 * the same token cannot both insert (UNIQUE(issuer, jti)), and two requests from one principal
 * cannot both read a count under the limit and both insert past it. A KV read-modify-write could
 * do neither.
 */
import type { Env } from '../../env';
import { ulid } from '../../lib/ulid';
import { AGENT_SIGN_IN_RATE_WINDOW_MS } from './config';

export interface AgentSignInClaimRecord {
  issuer: string;
  jti: string;
  sourceSubject: string;
  sourceProjectId: string;
  sourceUserId: string;
  sourceAgentProfileId: string | null;
  sourceTaskId: string | null;
  sourceWorkspaceId: string | null;
  targetUserId: string;
  tokenExpiresAtMs: number;
  sessionExpiresAtMs: number;
}

export type AgentSignInClaimOutcome =
  | { outcome: 'claimed'; id: string }
  | { outcome: 'replayed' }
  | { outcome: 'rate_limited'; retryAfterSeconds: number };

/**
 * Claim the token's jti and one unit of the principal's hourly budget, recording the audit row.
 * Spent only after the token verified and the target passed every check, so a party without a
 * valid token for an allowed principal cannot consume that principal's budget.
 */
export async function claimAgentSignIn(
  env: Pick<Env, 'DATABASE'>,
  record: AgentSignInClaimRecord,
  maxPerHour: number,
  nowMs = Date.now()
): Promise<AgentSignInClaimOutcome> {
  const id = ulid();
  const windowStartMs = nowMs - AGENT_SIGN_IN_RATE_WINDOW_MS;
  const row = await env.DATABASE.prepare(
    `INSERT INTO agent_sign_ins (
       id, issuer, jti, source_subject, source_project_id, source_user_id,
       source_agent_profile_id, source_task_id, source_workspace_id, target_user_id,
       token_expires_at, session_expires_at, created_at
     )
     SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
     WHERE (
       SELECT COUNT(*) FROM agent_sign_ins
       WHERE issuer = ? AND source_project_id = ? AND source_user_id = ? AND created_at > ?
     ) < ?
     ON CONFLICT(issuer, jti) DO NOTHING
     RETURNING id`
  )
    .bind(
      id,
      record.issuer,
      record.jti,
      record.sourceSubject,
      record.sourceProjectId,
      record.sourceUserId,
      record.sourceAgentProfileId,
      record.sourceTaskId,
      record.sourceWorkspaceId,
      record.targetUserId,
      record.tokenExpiresAtMs,
      record.sessionExpiresAtMs,
      nowMs,
      record.issuer,
      record.sourceProjectId,
      record.sourceUserId,
      windowStartMs,
      maxPerHour
    )
    .first<{ id: string }>();
  if (row) return { outcome: 'claimed', id: row.id };

  // Nothing inserted: either the jti is already recorded, or the principal is over budget.
  const seen = await env.DATABASE.prepare(
    'SELECT 1 AS seen FROM agent_sign_ins WHERE issuer = ? AND jti = ? LIMIT 1'
  )
    .bind(record.issuer, record.jti)
    .first<{ seen: number }>();
  if (seen) return { outcome: 'replayed' };

  const oldest = await env.DATABASE.prepare(
    `SELECT MIN(created_at) AS oldest FROM agent_sign_ins
     WHERE issuer = ? AND source_project_id = ? AND source_user_id = ? AND created_at > ?`
  )
    .bind(record.issuer, record.sourceProjectId, record.sourceUserId, windowStartMs)
    .first<{ oldest: number | null }>();
  const releaseAtMs = (oldest?.oldest ?? nowMs) + AGENT_SIGN_IN_RATE_WINDOW_MS;
  return {
    outcome: 'rate_limited',
    retryAfterSeconds: Math.max(1, Math.ceil((releaseAtMs - nowMs) / 1000)),
  };
}

/** Record which session a claimed sign-in produced, so the session refresh clamp can find it. */
export async function linkAgentSignInSession(
  env: Pick<Env, 'DATABASE'>,
  signInId: string,
  sessionId: string
): Promise<void> {
  await env.DATABASE.prepare(
    'UPDATE agent_sign_ins SET session_id = ? WHERE id = ? AND session_id IS NULL'
  )
    .bind(sessionId, signInId)
    .run();
}
