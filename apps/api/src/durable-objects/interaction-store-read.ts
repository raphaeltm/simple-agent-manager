import { type AcpInteractionSafeSummary, isJsonRecord } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { getCredentialEncryptionKey } from '../lib/secrets';
import { getAcpInteractionConfig } from '../services/acp-interaction-config';
import { decrypt } from '../services/encryption';
import {
  type InteractionRow,
  type InteractionStoreSnapshot,
  parseSummary,
} from './interaction-store-model';

export function readInteractionSnapshot(
  sql: SqlStorage,
  env: Env,
  cursor: string | null
): InteractionStoreSnapshot {
  const config = getAcpInteractionConfig(env);
  const pending = sql
    .exec<InteractionRow>(
      `SELECT * FROM interactions
     WHERE state IN ('pending', 'answered')
     ORDER BY created_at ASC
     LIMIT ?`,
      config.maxPendingPerSession + config.snapshotLastSettled
    )
    .toArray()
    .map(parseSummary);
  const settledRows = sql
    .exec<InteractionRow>(
      `SELECT * FROM interactions
     WHERE state NOT IN ('pending', 'answered')
       AND (? IS NULL OR updated_at < ?)
     ORDER BY updated_at DESC
     LIMIT ?`,
      cursor,
      cursor ? Number.parseInt(cursor, 10) : null,
      config.snapshotLastSettled + 1
    )
    .toArray();
  const pageRows = settledRows.slice(0, config.snapshotLastSettled);
  return {
    pending,
    settled: pageRows.map(parseSummary),
    cursor:
      settledRows.length > config.snapshotLastSettled
        ? String(pageRows[pageRows.length - 1]?.updated_at ?? '')
        : null,
  };
}

export async function readInteractionDetail(
  row: InteractionRow,
  env: Env
): Promise<{
  summary: AcpInteractionSafeSummary;
  detail: Record<string, unknown> | null;
}> {
  let detail: Record<string, unknown> | null = null;
  if (row.encrypted_detail?.length && row.detail_iv?.length) {
    const plaintext = await decrypt(
      row.encrypted_detail,
      row.detail_iv,
      getCredentialEncryptionKey(env)
    );
    const parsedDetail = JSON.parse(plaintext) as unknown;
    detail = isJsonRecord(parsedDetail) ? parsedDetail : null;
  }
  return { summary: parseSummary(row), detail };
}

/** Indexed existence probe independent of UI snapshot limits or expiry backlog. */
export function hasUnexpiredInteractionInput(sql: SqlStorage, now: number): boolean {
  return (
    sql
      .exec<{ pending: number }>(
        `SELECT 1 AS pending FROM interactions
     WHERE state IN ('pending', 'answered') AND deadline_at > ? LIMIT 1`,
        now
      )
      .toArray().length > 0
  );
}

export function readInteractionRow(sql: SqlStorage, interactionId: string): InteractionRow | null {
  return (
    sql
      .exec<InteractionRow>(
        'SELECT * FROM interactions WHERE interaction_id = ? LIMIT 1',
        interactionId
      )
      .toArray()[0] ?? null
  );
}
