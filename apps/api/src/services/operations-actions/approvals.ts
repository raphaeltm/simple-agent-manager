/**
 * D1 store for Operations action approvals (`operations_action_approvals`, migration 0221).
 *
 * Two compare-and-set writes are the whole safety story, and each guard lives in exactly one
 * place, the CAS `WHERE` clause, so deleting any one of them is observable (rule 62):
 *
 * - `decideApproval`: pending -> approved | denied, only while the request window is open.
 * - `claimApprovalForExecution`: approved -> executed, only for the same action and target,
 *   from the task that asked (or its own session-recovery successor), before expiry. One row
 *   changes at most once, so an approval runs at most once.
 *
 * After a CAS changes no row, `diagnose*` reads the row to name the reason. The diagnosis is
 * a message, never a guard.
 */
import {
  OPERATIONS_ACTION_TARGET_TYPES,
  OPERATIONS_ACTIONS,
  OPERATIONS_APPROVAL_STATUSES,
  type OperationsAction,
  type OperationsActionApproval,
  type OperationsActionTargetType,
  type OperationsApprovalDecision,
  type OperationsApprovalStatus,
} from '@simple-agent-manager/shared';

import { log } from '../../lib/logger';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { ulid } from '../../lib/ulid';

export const OPERATIONS_APPROVAL_REASON_MAX_CHARS = 1_000;
export const OPERATIONS_APPROVAL_EVIDENCE_MAX_CHARS = 4_000;
export const OPERATIONS_APPROVAL_NOTE_MAX_CHARS = 1_000;
export const OPERATIONS_APPROVAL_RESULT_MAX_CHARS = 4_000;
export const DEFAULT_OPERATIONS_APPROVAL_LIST_LIMIT = 50;
export const MAX_OPERATIONS_APPROVAL_LIST_LIMIT = 200;
export const DEFAULT_OPERATIONS_APPROVAL_PURGE_BATCH = 500;

const SELECT_COLUMNS = `id, action, target_type, target_id, reason, evidence_summary,
  target_summary_json, requesting_project_id, requesting_task_id, requesting_authority_task_id,
  requesting_session_id, requester_user_id, status, auto_approved, expires_at, decided_by,
  decided_at, decision_note, executed_at, execution_result_json, created_at`;

interface ApprovalRow {
  id: string;
  action: string;
  target_type: string;
  target_id: string;
  reason: string;
  evidence_summary: string | null;
  target_summary_json: string | null;
  requesting_project_id: string;
  requesting_task_id: string;
  requesting_authority_task_id: string;
  requesting_session_id: string | null;
  requester_user_id: string;
  status: string;
  auto_approved: number;
  expires_at: string;
  decided_by: string | null;
  decided_at: string | null;
  decision_note: string | null;
  executed_at: string | null;
  execution_result_json: string | null;
  created_at: string;
}

/** An approval plus the authority it was requested under (not part of the public shape). */
export interface StoredOperationsApproval extends OperationsActionApproval {
  requestingAuthorityTaskId: string;
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, max - 1)}…`;
}

function isAction(value: string): value is OperationsAction {
  return (OPERATIONS_ACTIONS as readonly string[]).includes(value);
}

function isStatus(value: string): value is OperationsApprovalStatus {
  return (OPERATIONS_APPROVAL_STATUSES as readonly string[]).includes(value);
}

function parseRecord(value: string | null): Record<string, unknown> | null {
  if (!value) return null;
  try {
    return maybeJsonRecord(JSON.parse(value) as unknown) ?? null;
  } catch {
    return null;
  }
}

function toApproval(row: ApprovalRow): StoredOperationsApproval | null {
  // A row this build cannot interpret is skipped, not thrown (rule 50).
  if (!isAction(row.action) || !isStatus(row.status)) {
    log.warn('operations_approvals.row_skipped', {
      approvalId: row.id,
      action: row.action,
      status: row.status,
    });
    return null;
  }
  return {
    id: row.id,
    action: row.action,
    targetType: row.target_type as OperationsActionTargetType,
    targetId: row.target_id,
    reason: row.reason,
    evidenceSummary: row.evidence_summary,
    targetSummary: parseRecord(
      row.target_summary_json
    ) as OperationsActionApproval['targetSummary'],
    requestingProjectId: row.requesting_project_id,
    requestingTaskId: row.requesting_task_id,
    requestingAuthorityTaskId: row.requesting_authority_task_id,
    requestingSessionId: row.requesting_session_id,
    requesterUserId: row.requester_user_id,
    status: row.status,
    autoApproved: row.auto_approved === 1,
    expiresAt: row.expires_at,
    decidedBy: row.decided_by,
    decidedAt: row.decided_at,
    decisionNote: row.decision_note,
    executedAt: row.executed_at,
    executionResult: parseRecord(row.execution_result_json),
    createdAt: row.created_at,
  };
}

/** The public shape, without the internal authority column. */
export function publicApproval(approval: StoredOperationsApproval): OperationsActionApproval {
  const { requestingAuthorityTaskId: _authority, ...rest } = approval;
  return rest;
}

export interface CreateApprovalInput {
  action: OperationsAction;
  targetId: string;
  reason: string;
  evidenceSummary: string | null;
  targetSummary: Record<string, string | number | boolean | null>;
  requestingProjectId: string;
  requestingTaskId: string;
  requestingAuthorityTaskId: string;
  requestingSessionId: string | null;
  requesterUserId: string;
  /** True when the action matrix lets this mode skip the human tap. */
  autoApproved: boolean;
  ttlMs: number;
  now?: Date;
}

export async function createApproval(
  db: D1Database,
  input: CreateApprovalInput
): Promise<StoredOperationsApproval> {
  const now = input.now ?? new Date();
  const id = ulid();
  const nowIso = now.toISOString();
  await db
    .prepare(
      `INSERT INTO operations_action_approvals
         (id, action, target_type, target_id, reason, evidence_summary, target_summary_json,
          requesting_project_id, requesting_task_id, requesting_authority_task_id,
          requesting_session_id, requester_user_id, status, auto_approved, expires_at,
          decided_at, decision_note, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .bind(
      id,
      input.action,
      OPERATIONS_ACTION_TARGET_TYPES[input.action],
      input.targetId,
      bounded(input.reason, OPERATIONS_APPROVAL_REASON_MAX_CHARS),
      input.evidenceSummary
        ? bounded(input.evidenceSummary, OPERATIONS_APPROVAL_EVIDENCE_MAX_CHARS)
        : null,
      JSON.stringify(input.targetSummary),
      input.requestingProjectId,
      input.requestingTaskId,
      input.requestingAuthorityTaskId,
      input.requestingSessionId,
      input.requesterUserId,
      input.autoApproved ? 'approved' : 'pending',
      input.autoApproved ? 1 : 0,
      new Date(now.getTime() + input.ttlMs).toISOString(),
      input.autoApproved ? nowIso : null,
      input.autoApproved ? 'Auto-approved: operations.debuggerTools is read_auto_safe' : null,
      nowIso
    )
    .run();
  const created = await getApproval(db, id);
  if (!created) throw new Error(`Operations approval ${id} was not readable after insert`);
  return created;
}

export async function getApproval(
  db: D1Database,
  id: string
): Promise<StoredOperationsApproval | null> {
  const row = await db
    .prepare(`SELECT ${SELECT_COLUMNS} FROM operations_action_approvals WHERE id = ?`)
    .bind(id)
    .first<ApprovalRow>();
  return row ? toApproval(row) : null;
}

/** Pending first, then newest first. */
export async function listApprovals(
  db: D1Database,
  options: { status?: OperationsApprovalStatus; limit?: number } = {}
): Promise<StoredOperationsApproval[]> {
  const limit = Math.max(
    1,
    Math.min(
      MAX_OPERATIONS_APPROVAL_LIST_LIMIT,
      options.limit ?? DEFAULT_OPERATIONS_APPROVAL_LIST_LIMIT
    )
  );
  const rows = options.status
    ? await db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM operations_action_approvals
            WHERE status = ? ORDER BY created_at DESC, id DESC LIMIT ?`
        )
        .bind(options.status, limit)
        .all<ApprovalRow>()
    : await db
        .prepare(
          `SELECT ${SELECT_COLUMNS} FROM operations_action_approvals
            ORDER BY CASE WHEN status = 'pending' THEN 0 ELSE 1 END, created_at DESC, id DESC
            LIMIT ?`
        )
        .bind(limit)
        .all<ApprovalRow>();
  return (rows.results ?? []).flatMap((row) => {
    const approval = toApproval(row);
    return approval ? [approval] : [];
  });
}

export type DecideApprovalOutcome =
  | { outcome: 'decided'; approval: StoredOperationsApproval }
  | { outcome: 'not_found' }
  | { outcome: 'expired'; approval: StoredOperationsApproval }
  | { outcome: 'already_decided'; approval: StoredOperationsApproval };

/**
 * pending -> approved | denied while the request window is open. An approval's execution
 * window restarts at the decision, so a late approval is still usable for `ttlMs`.
 */
export async function decideApproval(
  db: D1Database,
  input: {
    id: string;
    decision: OperationsApprovalDecision;
    deciderUserId: string;
    note: string | null;
    ttlMs: number;
    now?: Date;
  }
): Promise<DecideApprovalOutcome> {
  const now = input.now ?? new Date();
  const nowIso = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE operations_action_approvals
          SET status = ?, decided_by = ?, decided_at = ?, decision_note = ?, expires_at = ?
        WHERE id = ?
          AND status = 'pending'
          AND expires_at > ?`
    )
    .bind(
      input.decision === 'approve' ? 'approved' : 'denied',
      input.deciderUserId,
      nowIso,
      input.note ? bounded(input.note, OPERATIONS_APPROVAL_NOTE_MAX_CHARS) : null,
      input.decision === 'approve' ? new Date(now.getTime() + input.ttlMs).toISOString() : nowIso,
      input.id,
      nowIso
    )
    .run();
  const approval = await getApproval(db, input.id);
  if (!approval) return { outcome: 'not_found' };
  if ((result.meta?.changes ?? 0) === 1) return { outcome: 'decided', approval };
  if (approval.status === 'pending') {
    return { outcome: 'expired', approval: (await expireApproval(db, approval, now)) ?? approval };
  }
  return { outcome: 'already_decided', approval };
}

async function expireApproval(
  db: D1Database,
  approval: StoredOperationsApproval,
  now: Date
): Promise<StoredOperationsApproval | null> {
  await db
    .prepare(
      `UPDATE operations_action_approvals SET status = 'expired'
        WHERE id = ? AND status IN ('pending', 'approved') AND expires_at <= ?`
    )
    .bind(approval.id, now.toISOString())
    .run();
  return getApproval(db, approval.id);
}

export interface ExecutionClaim {
  id: string;
  action: OperationsAction;
  targetId: string;
  /** The executing token's project. */
  projectId: string;
  /** The executing task's stable source-task authority (`recovery_source_task_id ?? id`). */
  authorityTaskId: string;
  now?: Date;
}

export type ExecutionRefusal =
  | 'not_found'
  | 'other_task'
  | 'action_mismatch'
  | 'target_mismatch'
  | 'not_approved'
  | 'denied'
  | 'expired'
  | 'already_executed';

export type ClaimExecutionOutcome =
  | { claimed: true; approval: StoredOperationsApproval }
  | { claimed: false; refusal: ExecutionRefusal; approval: StoredOperationsApproval | null };

/**
 * approved -> executed, atomically. Every guard is a conjunct here and nowhere else.
 */
export async function claimApprovalForExecution(
  db: D1Database,
  claim: ExecutionClaim
): Promise<ClaimExecutionOutcome> {
  const now = claim.now ?? new Date();
  const nowIso = now.toISOString();
  const result = await db
    .prepare(
      `UPDATE operations_action_approvals
          SET status = 'executed', executed_at = ?
        WHERE id = ?
          AND status = 'approved'
          AND expires_at > ?
          AND action = ?
          AND target_id = ?
          AND requesting_project_id = ?
          AND requesting_authority_task_id = ?`
    )
    .bind(
      nowIso,
      claim.id,
      nowIso,
      claim.action,
      claim.targetId,
      claim.projectId,
      claim.authorityTaskId
    )
    .run();
  const approval = await getApproval(db, claim.id);
  if ((result.meta?.changes ?? 0) === 1 && approval) return { claimed: true, approval };
  return { claimed: false, refusal: diagnoseRefusal(approval, claim, now), approval };
}

/** Names why a claim changed no row. Order: identity first, then state. */
function diagnoseRefusal(
  approval: StoredOperationsApproval | null,
  claim: ExecutionClaim,
  now: Date
): ExecutionRefusal {
  if (!approval) return 'not_found';
  if (
    approval.requestingProjectId !== claim.projectId ||
    approval.requestingAuthorityTaskId !== claim.authorityTaskId
  ) {
    return 'other_task';
  }
  if (approval.action !== claim.action) return 'action_mismatch';
  if (approval.targetId !== claim.targetId) return 'target_mismatch';
  if (approval.status === 'executed') return 'already_executed';
  if (approval.status === 'denied') return 'denied';
  if (approval.status === 'expired' || Date.parse(approval.expiresAt) <= now.getTime()) {
    return 'expired';
  }
  return 'not_approved';
}

/** Stores a bounded execution outcome on an executed row. Never throws. */
export async function recordExecutionResult(
  db: D1Database,
  id: string,
  result: Record<string, unknown>
): Promise<void> {
  try {
    const text = JSON.stringify(result);
    await db
      .prepare(
        `UPDATE operations_action_approvals SET execution_result_json = ?
          WHERE id = ? AND status = 'executed'`
      )
      .bind(
        text.length <= OPERATIONS_APPROVAL_RESULT_MAX_CHARS
          ? text
          : JSON.stringify({ truncated: true, status: result.status ?? null }),
        id
      )
      .run();
  } catch (error) {
    log.error('operations_approvals.result_write_failed', {
      approvalId: id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** Daily: flip lapsed pending/approved rows to expired. */
export async function expireLapsedApprovals(
  db: D1Database,
  now: Date = new Date()
): Promise<number> {
  const result = await db
    .prepare(
      `UPDATE operations_action_approvals SET status = 'expired'
        WHERE status IN ('pending', 'approved') AND expires_at <= ?`
    )
    .bind(now.toISOString())
    .run();
  return result.meta?.changes ?? 0;
}

/** Daily: delete one bounded batch of settled rows older than the retention window. */
export async function purgeSettledApprovals(
  db: D1Database,
  retentionDays: number,
  now: Date = new Date(),
  batchSize: number = DEFAULT_OPERATIONS_APPROVAL_PURGE_BATCH
): Promise<number> {
  const cutoff = new Date(now.getTime() - retentionDays * 86_400_000).toISOString();
  const result = await db
    .prepare(
      `DELETE FROM operations_action_approvals WHERE id IN (
         SELECT id FROM operations_action_approvals
          WHERE status IN ('denied', 'expired', 'executed') AND created_at < ?
          ORDER BY created_at LIMIT ?)`
    )
    .bind(cutoff, batchSize)
    .run();
  return result.meta?.changes ?? 0;
}
