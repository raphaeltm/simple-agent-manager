import {
  type AcpInteractionAnswerDecision,
  type AcpInteractionRuntimeCompleteUrl,
  eligibleAcpUrl,
  isJsonRecord,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import type { AcpInteractionConfig } from '../services/acp-interaction-config';
import { type InteractionRow, nowMs, sha256 } from './interaction-store-model';
import { readInteractionDetail } from './interaction-store-read';

export function validUrlCreateDetail(value: unknown, config: AcpInteractionConfig): boolean {
  if (
    !isJsonRecord(value) ||
    !Object.keys(value).every((key) => ['message', 'url', 'elicitationId'].includes(key)) ||
    typeof value.message !== 'string' ||
    typeof value.url !== 'string' ||
    typeof value.elicitationId !== 'string'
  )
    return false;
  return (
    new TextEncoder().encode(value.message).byteLength <= config.requestMaxBytes &&
    value.elicitationId.length > 0 &&
    value.elicitationId.length <= config.urlElicitationIdMaxChars &&
    eligibleAcpUrl(value.url, config.urlMaxChars, config.urlRedirectDepth) !== null
  );
}

export async function validUrlAnswerDecision(
  decision: AcpInteractionAnswerDecision
): Promise<boolean> {
  if (
    !['accepted', 'declined', 'cancelled'].includes(decision.kind) ||
    decision.content !== undefined ||
    decision.optionId !== undefined ||
    decision.encryptedAnswer !== undefined
  )
    return false;
  return decision.answerHash === (await sha256(decision.kind));
}

export async function completeUrlInteraction(
  sql: SqlStorage,
  env: Env,
  input: AcpInteractionRuntimeCompleteUrl
): Promise<{ status: 'completed' | 'duplicate' | 'not_found' | 'stale' }> {
  const read = () =>
    sql
      .exec<InteractionRow>(
        `SELECT * FROM interactions WHERE interaction_id = ? LIMIT 1`,
        input.interactionId
      )
      .toArray()[0] ?? null;
  const eligibleState = (row: InteractionRow) =>
    row.deadline_at > nowMs() &&
    ['pending', 'answered', 'delivery_confirmed', 'delivery_unconfirmed'].includes(row.state);
  const row = read();
  if (!row || row.kind !== 'url') return { status: 'not_found' };
  if (
    row.generation !== input.generation ||
    row.runtime_identity !== input.runtimeIdentity ||
    row.agent_session_id !== input.agentSessionId ||
    !eligibleState(row)
  )
    return { status: 'stale' };
  const detail = await readInteractionDetail(row, env);
  if (detail.detail?.elicitationId !== input.elicitationId) return { status: 'stale' };
  const current = read();
  if (
    !current ||
    current.generation !== input.generation ||
    current.runtime_identity !== input.runtimeIdentity ||
    current.agent_session_id !== input.agentSessionId
  )
    return { status: 'stale' };
  if (current.url_completed_at !== null) return { status: 'duplicate' };
  if (!eligibleState(current)) return { status: 'stale' };
  const at = nowMs();
  sql.exec(
    `UPDATE interactions SET url_completed_at = ?, updated_at = ?
    WHERE interaction_id = ? AND url_completed_at IS NULL`,
    at,
    at,
    input.interactionId
  );
  return { status: 'completed' };
}
