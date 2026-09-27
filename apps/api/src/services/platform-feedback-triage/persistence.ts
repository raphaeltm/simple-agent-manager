import type { Env } from '../../env';
import { D1_MAX_BOUND_PARAMETERS } from '../../lib/d1-limits';
import { normalizeSeverity, parseStoredEvidenceRefs } from './grouping';
import type {
  ErrorRow,
  ExistingTriagePriorityRow,
  FeedbackErrorGroup,
  StoredTriageGroupRow,
} from './types';

const FEEDBACK_PROJECT_TASK_ID_CHUNK_SIZE = D1_MAX_BOUND_PARAMETERS - 1;

interface SignatureAliasRow {
  signature: string;
  canonical_signature: string | null;
  idea_id: string | null;
  occurrence_count: number;
  created_at: string;
}

function signatureMatchRank(row: SignatureAliasRow, group: FeedbackErrorGroup): number {
  const canonical = group.canonicalSignature ?? group.signature;
  if (row.signature === canonical) return 0;
  if (row.canonical_signature === canonical) return 1;
  if (row.idea_id) return 2;
  return 3;
}

export async function resolveExistingGroupSignatures(
  env: Env,
  groups: FeedbackErrorGroup[]
): Promise<FeedbackErrorGroup[]> {
  const rows: SignatureAliasRow[] = [];
  const candidates = [
    ...new Set(
      groups.flatMap((group) => [
        group.canonicalSignature ?? group.signature,
        ...(group.legacySignatures ?? []),
      ])
    ),
  ];
  const chunkSize = Math.floor(D1_MAX_BOUND_PARAMETERS / 2);
  for (let offset = 0; offset < candidates.length; offset += chunkSize) {
    const chunk = candidates.slice(offset, offset + chunkSize);
    const placeholders = chunk.map(() => '?').join(',');
    const query = await env.DATABASE.prepare(
      `SELECT signature, canonical_signature, idea_id, occurrence_count, created_at
       FROM platform_feedback_triages
       WHERE canonical_signature IN (${placeholders}) OR signature IN (${placeholders})`
    )
      .bind(...chunk, ...chunk)
      .all<SignatureAliasRow>();
    rows.push(...(query.results ?? []));
  }

  return Promise.all(
    groups.map(async (group) => {
      const canonical = group.canonicalSignature ?? group.signature;
      const candidates = new Set([canonical, ...(group.legacySignatures ?? [])]);
      const matched = rows
        .filter((row) => row.canonical_signature === canonical || candidates.has(row.signature))
        .sort(
          (left, right) =>
            signatureMatchRank(left, group) - signatureMatchRank(right, group) ||
            right.occurrence_count - left.occurrence_count ||
            left.created_at.localeCompare(right.created_at) ||
            left.signature.localeCompare(right.signature)
        )[0];
      if (!matched) return group;

      if (matched.canonical_signature !== canonical) {
        try {
          await env.DATABASE.prepare(
            `UPDATE platform_feedback_triages SET canonical_signature = ?, updated_at = CURRENT_TIMESTAMP
             WHERE signature = ? AND canonical_signature IS NULL`
          )
            .bind(canonical, matched.signature)
            .run();
        } catch (cause) {
          const winner = await env.DATABASE.prepare(
            `SELECT signature, canonical_signature, idea_id, occurrence_count, created_at
             FROM platform_feedback_triages WHERE canonical_signature = ?`
          )
            .bind(canonical)
            .first<SignatureAliasRow>();
          if (winner) return { ...group, signature: winner.signature };
          throw cause;
        }
      }
      return { ...group, signature: matched.signature };
    })
  );
}

export async function recordGroupFailure(
  env: Env,
  signature: string,
  claimToken: string,
  now: number,
  maxFailures: number,
  reason: string
): Promise<{ rejected: boolean }> {
  const existing = await env.DATABASE.prepare(
    'SELECT failure_count FROM platform_feedback_triages WHERE signature = ? AND claim_token = ?'
  )
    .bind(signature, claimToken)
    .first<{ failure_count: number }>();
  const nextFailures = (existing?.failure_count ?? 0) + 1;
  const rejectedAt = nextFailures >= maxFailures ? now : null;
  await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET failure_count = failure_count + 1, last_failure_reason = ?,
    last_failed_at = ?, rejected_at = COALESCE(rejected_at, ?), claim_token = NULL, claim_expires_at = NULL,
    budget_deferred_until = NULL, budget_deferred_reason = NULL,
    queue_state = CASE WHEN ? IS NOT NULL THEN 'rejected' ELSE queue_state END,
    updated_at = CURRENT_TIMESTAMP WHERE signature = ? AND claim_token = ?`
  )
    .bind(reason, now, rejectedAt, rejectedAt, signature, claimToken)
    .run();
  return { rejected: rejectedAt !== null };
}

export async function recordGroupBudgetDeferral(
  env: Env,
  signature: string,
  claimToken: string,
  now: number,
  reason: string,
  deferredUntil: number
): Promise<boolean> {
  const result = await env.DATABASE.prepare(
    `UPDATE platform_feedback_triages SET
      budget_deferred_until = ?,
      budget_deferred_reason = ?,
      budget_defer_count = budget_defer_count + 1,
      last_budget_deferred_at = ?,
      last_failure_reason = ?,
      last_failed_at = ?,
      claim_token = NULL,
      claim_expires_at = NULL,
      queue_state = CASE
        WHEN rejected_at IS NOT NULL THEN 'rejected'
        ELSE queue_state
      END,
      queued_at = CASE
        WHEN rejected_at IS NOT NULL THEN queued_at
        WHEN queued_at IS NULL AND queue_state NOT IN ('resolved', 'expired') THEN ?
        ELSE queued_at
      END,
      updated_at = CURRENT_TIMESTAMP
     WHERE signature = ? AND claim_token = ?`
  )
    .bind(deferredUntil, reason, now, reason, now, now, signature, claimToken)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

export async function excludeFeedbackProjectTaskErrors(
  env: Env,
  rows: ErrorRow[],
  feedbackProjectId: string
): Promise<ErrorRow[]> {
  const taskIds = [
    ...new Set(rows.map((row) => row.task_id).filter((id): id is string => Boolean(id))),
  ];
  if (taskIds.length === 0) return rows;
  const selfTaskIds = new Set<string>();
  for (let offset = 0; offset < taskIds.length; offset += FEEDBACK_PROJECT_TASK_ID_CHUNK_SIZE) {
    const chunk = taskIds.slice(offset, offset + FEEDBACK_PROJECT_TASK_ID_CHUNK_SIZE);
    const placeholders = chunk.map(() => '?').join(', ');
    const query = await env.DATABASE.prepare(
      `SELECT id FROM tasks WHERE project_id = ? AND id IN (${placeholders})`
    )
      .bind(feedbackProjectId, ...chunk)
      .all<{ id: string }>();
    for (const row of query.results ?? []) {
      selfTaskIds.add(row.id);
    }
  }
  return rows.filter((row) => !row.task_id || !selfTaskIds.has(row.task_id));
}

export async function annotateNodeAgentVersions(env: Env, rows: ErrorRow[]): Promise<ErrorRow[]> {
  const nodeIds = [
    ...new Set(rows.map((row) => row.node_id?.trim()).filter((id): id is string => Boolean(id))),
  ];
  if (nodeIds.length === 0) return rows;

  const versions = new Map<string, string | null>();
  for (let offset = 0; offset < nodeIds.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const chunk = nodeIds.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    const query = await env.DATABASE.prepare(
      `SELECT id, agent_version FROM nodes WHERE id IN (${chunk.map(() => '?').join(',')})`
    )
      .bind(...chunk)
      .all<{ id: string; agent_version: string | null }>();
    for (const row of query.results ?? []) {
      versions.set(row.id, row.agent_version);
    }
  }

  return rows.map((row) => {
    const nodeId = row.node_id?.trim();
    return nodeId ? { ...row, nodeAgentVersion: versions.get(nodeId) ?? null } : row;
  });
}

export async function loadExistingTriageRows(
  env: Env,
  signatures: string[]
): Promise<Map<string, ExistingTriagePriorityRow>> {
  const rows = new Map<string, ExistingTriagePriorityRow>();
  for (let offset = 0; offset < signatures.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const chunk = signatures.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    if (chunk.length === 0) continue;
    const query = await env.DATABASE.prepare(
      `SELECT triage.signature, triage.canonical_signature, triage.source, triage.diagnosis_id, triage.idea_id,
        triage.occurrence_count, triage.severity, triage.budget_deferred_until,
        triage.rejected_at, triage.queue_state, triage.resolved_at,
        triage.resolved_by_task_id, resolved_task.output_pr_url AS resolved_task_output_pr_url,
        triage.resolution_note, triage.resolution_references, triage.expired_at
       FROM platform_feedback_triages triage
       LEFT JOIN tasks resolved_task ON resolved_task.id = triage.resolved_by_task_id
       WHERE triage.signature IN (${chunk.map(() => '?').join(',')})`
    )
      .bind(...chunk)
      .all<ExistingTriagePriorityRow>();
    for (const row of query.results ?? []) rows.set(row.signature, row);
  }
  return rows;
}

export async function readExistingTriageRow(
  env: Env,
  signature: string
): Promise<ExistingTriagePriorityRow | undefined> {
  return (await loadExistingTriageRows(env, [signature])).get(signature);
}

export async function loadDueBudgetDeferredGroups(
  env: Env,
  now: number,
  existingSignatures: Set<string>,
  limit: number,
  evidenceLimit: number
): Promise<FeedbackErrorGroup[]> {
  if (limit <= 0) return [];
  const query = await env.DATABASE.prepare(
    `SELECT signature, source, summary, severity, first_seen_at, last_seen_at,
      occurrence_count, evidence_refs
     FROM platform_feedback_triages
     WHERE rejected_at IS NULL
       AND idea_id IS NULL
       AND queue_state = 'pending'
       AND budget_deferred_until IS NOT NULL
       AND budget_deferred_until <= ?
       AND (claim_expires_at IS NULL OR claim_expires_at < ?)
     ORDER BY CASE severity WHEN 'error' THEN 0 WHEN 'warn' THEN 1 ELSE 2 END ASC,
       CASE WHEN diagnosis_id IS NULL AND idea_id IS NULL THEN 0 ELSE 1 END ASC,
       occurrence_count ASC,
       last_seen_at DESC
     LIMIT ?`
  )
    .bind(now, now, limit + existingSignatures.size)
    .all<StoredTriageGroupRow>();

  return (query.results ?? [])
    .filter((row) => !existingSignatures.has(row.signature))
    .slice(0, limit)
    .map((row) => ({
      signature: row.signature,
      source: row.source,
      severity: normalizeSeverity(row.severity),
      summary: row.summary,
      firstSeenAt: row.first_seen_at,
      lastSeenAt: row.last_seen_at,
      evidence: parseStoredEvidenceRefs(row.evidence_refs, evidenceLimit),
      count: row.occurrence_count,
    }));
}
