import { isJsonRecord } from '@simple-agent-manager/shared';

import { createModuleLogger } from '../../lib/logger';
import { recordActivityEventInternal } from './activity';
import {
  reconciliationCandidateLeaseMs,
  reconciliationProbeMaxAttempts,
  reconciliationQuarantineMs,
} from './reconciliation-thresholds';
import type { Env } from './types';

const log = createModuleLogger('reconciliation');

const CURSOR_META_KEY = 'taskReconciliationCursor';
export const CANDIDATE_GATE_META_PREFIX = 'taskReconciliationGate:';

export interface ReconciliationCursor {
  lastActivityAt: number;
  sessionId: string;
}

interface ReconciliationGate {
  attempts: number;
  nextAttemptAt: number;
}

function readMeta(sql: SqlStorage, key: string): string | null {
  const row = sql.exec('SELECT value FROM do_meta WHERE key = ?', key).toArray()[0];
  return isJsonRecord(row) && typeof row.value === 'string' ? row.value : null;
}

function writeMeta(sql: SqlStorage, key: string, value: unknown): void {
  sql.exec(
    `INSERT INTO do_meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
    key,
    JSON.stringify(value)
  );
}

function parseCursor(raw: string | null): ReconciliationCursor | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isJsonRecord(parsed) ||
      typeof parsed.lastActivityAt !== 'number' ||
      !Number.isFinite(parsed.lastActivityAt) ||
      typeof parsed.sessionId !== 'string'
    ) {
      return null;
    }
    return { lastActivityAt: parsed.lastActivityAt, sessionId: parsed.sessionId };
  } catch {
    return null;
  }
}

function parseGate(raw: string | null): ReconciliationGate | null {
  if (!raw) return null;
  try {
    const parsed: unknown = JSON.parse(raw);
    if (
      !isJsonRecord(parsed) ||
      typeof parsed.attempts !== 'number' ||
      !Number.isSafeInteger(parsed.attempts) ||
      parsed.attempts < 0 ||
      typeof parsed.nextAttemptAt !== 'number' ||
      !Number.isFinite(parsed.nextAttemptAt)
    ) {
      return null;
    }
    return { attempts: parsed.attempts, nextAttemptAt: parsed.nextAttemptAt };
  } catch {
    return null;
  }
}

function gateKey(sessionId: string): string {
  return `${CANDIDATE_GATE_META_PREFIX}${sessionId}`;
}

export function readReconciliationCursor(sql: SqlStorage): ReconciliationCursor | null {
  return parseCursor(readMeta(sql, CURSOR_META_KEY));
}

export function writeReconciliationCursor(sql: SqlStorage, cursor: ReconciliationCursor): void {
  writeMeta(sql, CURSOR_META_KEY, cursor);
}

export function resetReconciliationCursor(sql: SqlStorage): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', CURSOR_META_KEY);
}

/** Synchronously claim one candidate before any remote/D1 await. */
export function claimReconciliationCandidate(
  sql: SqlStorage,
  sessionId: string,
  options: { now: number; leaseMs: number; maxAttempts: number }
): boolean {
  const key = gateKey(sessionId);
  const existing = parseGate(readMeta(sql, key));
  if (existing && existing.nextAttemptAt > options.now) return false;

  // An expired quarantine starts a fresh bounded attempt series.
  const attempts = existing && existing.attempts < options.maxAttempts ? existing.attempts : 0;
  writeMeta(sql, key, { attempts, nextAttemptAt: options.now + options.leaseMs });
  return true;
}

export function deferReconciliationCandidate(
  sql: SqlStorage,
  sessionId: string,
  options: { now: number; leaseMs: number; maxAttempts: number; quarantineMs: number }
): { attempts: number; quarantined: boolean; nextAttemptAt: number } {
  const key = gateKey(sessionId);
  const existing = parseGate(readMeta(sql, key));
  const attempts = Math.min((existing?.attempts ?? 0) + 1, options.maxAttempts);
  const quarantined = attempts >= options.maxAttempts;
  const nextAttemptAt = options.now + (quarantined ? options.quarantineMs : options.leaseMs);
  writeMeta(sql, key, { attempts, nextAttemptAt });
  return { attempts, quarantined, nextAttemptAt };
}

export function deferReconciliationCandidateUntil(
  sql: SqlStorage,
  sessionId: string,
  nextAttemptAt: number
): void {
  writeMeta(sql, gateKey(sessionId), { attempts: 0, nextAttemptAt });
}

export function clearReconciliationCandidateGate(sql: SqlStorage, sessionId: string): void {
  sql.exec('DELETE FROM do_meta WHERE key = ?', gateKey(sessionId));
}

/** Parse the value selected through an alarm query's correlated do_meta join. */
export function parseReconciliationCandidateNotBefore(value: unknown): number | null {
  return typeof value === 'string' ? (parseGate(value)?.nextAttemptAt ?? null) : null;
}

export function recordReconciliationCandidateInconclusive(
  sql: SqlStorage,
  env: Env,
  candidate: { sessionId: string; workspaceId: string; taskId: string; reason: string }
): void {
  const result = deferReconciliationCandidate(sql, candidate.sessionId, {
    now: Date.now(),
    leaseMs: reconciliationCandidateLeaseMs(env),
    maxAttempts: reconciliationProbeMaxAttempts(env),
    quarantineMs: reconciliationQuarantineMs(env),
  });
  if (!result.quarantined) return;

  recordActivityEventInternal(
    sql,
    'reconciliation.candidate_quarantined',
    'system',
    null,
    candidate.workspaceId,
    candidate.sessionId,
    candidate.taskId,
    JSON.stringify({
      attempts: result.attempts,
      reason: candidate.reason,
      nextAttemptAt: result.nextAttemptAt,
    })
  );
  log.warn('reconciliation.candidate_quarantined', {
    sessionId: candidate.sessionId,
    taskId: candidate.taskId,
    workspaceId: candidate.workspaceId,
    attempts: result.attempts,
    reason: candidate.reason,
    nextAttemptAt: result.nextAttemptAt,
    action: 'preserved',
  });
}
