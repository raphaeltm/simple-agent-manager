import {
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { D1_MAX_BOUND_PARAMETERS } from '../lib/d1-limits';
import { log } from '../lib/logger';
import { ulid } from '../lib/ulid';
import { runDebugDiagnosis, SCHEDULED_TRIAGE_DEBUG_FEATURE_KEY } from './debug-agent';
import { redactSensitiveData } from './observability';
import { configuredFeedbackProjectId, markIncidentPending } from './platform-feedback-incidents';
import { formatUntrustedIdeaContent } from './untrusted-idea-content';

export type FeedbackTriageTrigger = 'cron' | 'manual';
export interface FeedbackTriageResult {
  enabled: boolean;
  trigger: FeedbackTriageTrigger;
  groupsFound: number;
  ideasCreated: number;
  ideasUpdated: number;
  groupsSkipped: number;
  groupsFailed: number;
  groupsBudgetDeferred: number;
  failureReasons: string[];
}
interface ErrorRow {
  id: string;
  source: string;
  level?: string | null;
  message: string;
  timestamp: number;
  task_id?: string | null;
}
type FeedbackSeverity = 'error' | 'warn';
export interface FeedbackErrorGroup {
  signature: string;
  source: string;
  severity: FeedbackSeverity;
  summary: string;
  firstSeenAt: number;
  lastSeenAt: number;
  evidence: Array<{ errorId: string; timestamp: number }>;
  count: number;
}
interface ExistingTriagePriorityRow {
  signature: string;
  diagnosis_id: string | null;
  idea_id: string | null;
  occurrence_count: number;
  severity: string | null;
  budget_deferred_until: number | null;
  rejected_at: number | null;
  queue_state: string | null;
}
interface StoredTriageGroupRow {
  signature: string;
  source: string;
  summary: string;
  severity: string | null;
  first_seen_at: number;
  last_seen_at: number;
  occurrence_count: number;
  evidence_refs: string;
}
interface TriageDeps {
  now?: () => number;
  diagnose?: typeof runDebugDiagnosis;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}
function sanitizeFailureReason(cause: unknown, maxLength: number): string {
  const raw = cause instanceof Error ? cause.message : String(cause);
  const redacted = String(redactSensitiveData(raw || 'unknown triage failure'))
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\b01[a-z0-9]{24}\b/gi, '[id]')
    .replace(/\s+/g, ' ')
    .trim();
  return (redacted || 'unknown triage failure').slice(0, maxLength);
}
function normalizeSeverity(level: string | null | undefined): FeedbackSeverity {
  return level === 'warn' ? 'warn' : 'error';
}

function severityRank(severity: string | null | undefined): number {
  return normalizeSeverity(severity) === 'error' ? 2 : 1;
}

function normalizeMessage(message: string): string {
  return String(redactSensitiveData(message))
    .toLowerCase()
    .replace(/\b[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/https?:\/\/\S+/g, '[url]')
    .replace(/\b[0-9a-f]{8}-[0-9a-f-]{27,}\b/gi, '[id]')
    .replace(/\b01[a-z0-9]{24}\b/gi, '[id]')
    .replace(/\b\d{3,}\b/g, '[n]')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 500);
}

function parseStoredEvidenceRefs(
  raw: string,
  evidenceLimit: number
): FeedbackErrorGroup['evidence'] {
  try {
    const parsed = JSON.parse(raw) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed
      .map((item) => {
        if (!item || typeof item !== 'object') return null;
        const record = item as Record<string, unknown>;
        if (typeof record.errorId !== 'string') return null;
        if (typeof record.timestamp !== 'number' || !Number.isFinite(record.timestamp)) {
          return null;
        }
        return { errorId: record.errorId, timestamp: record.timestamp };
      })
      .filter((item): item is { errorId: string; timestamp: number } => item !== null)
      .slice(0, evidenceLimit);
  } catch {
    return [];
  }
}

function classifyBudgetBlock(reason: string): 'daily' | 'per-run' | null {
  if (reason === 'Daily deployment debugging budget exhausted') return 'daily';
  if (reason === 'Per-run debugging token ceiling reached') return 'per-run';
  return null;
}

function nextUtcDayStart(now: number): number {
  const date = new Date(now);
  return Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1);
}
const ALLOWED_ERROR_SOURCES = new Set(['api', 'client', 'vm-agent']);
async function digest(value: string): Promise<string> {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return [...new Uint8Array(bytes)].map((item) => item.toString(16).padStart(2, '0')).join('');
}
export async function groupPlatformErrors(
  rows: ErrorRow[],
  evidenceLimit: number
): Promise<FeedbackErrorGroup[]> {
  const groups = new Map<string, Omit<FeedbackErrorGroup, 'signature'>>();
  for (const row of rows) {
    const candidateSource = row.source.trim().toLowerCase();
    const source = ALLOWED_ERROR_SOURCES.has(candidateSource) ? candidateSource : 'unknown';
    const severity = normalizeSeverity(row.level);
    const normalized = normalizeMessage(row.message) || 'redacted platform error';
    const summary = `Recurring ${source} platform error`;
    const key = `${source}\n${normalized}`;
    const current = groups.get(key);
    const safeErrorId =
      /^(?:[0-9A-HJKMNP-TV-Z]{26}|[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.test(
        row.id
      )
        ? row.id
        : 'invalid-redacted-id';
    const evidence = { errorId: safeErrorId, timestamp: row.timestamp };
    if (current) {
      current.count += 1;
      current.severity =
        severityRank(severity) > severityRank(current.severity) ? severity : current.severity;
      current.firstSeenAt = Math.min(current.firstSeenAt, row.timestamp);
      current.lastSeenAt = Math.max(current.lastSeenAt, row.timestamp);
      if (current.evidence.length < evidenceLimit) current.evidence.push(evidence);
    } else {
      groups.set(key, {
        source,
        severity,
        summary,
        firstSeenAt: row.timestamp,
        lastSeenAt: row.timestamp,
        evidence: [evidence],
        count: 1,
      });
    }
  }
  return Promise.all(
    [...groups.entries()].map(async ([key, group]) => ({ ...group, signature: await digest(key) }))
  );
}
function ideaDescription(group: FeedbackErrorGroup, diagnosisId: string): string {
  const refs = group.evidence
    .map((item) => `- ${item.errorId} at ${new Date(item.timestamp).toISOString()}`)
    .join('\n');

  return formatUntrustedIdeaContent({
    trustedSummary:
      'Triage this automated platform feedback report. Raw observability messages were normalized/redacted before grouping; only allowlisted bounded metadata is stored below.',
    trustedDetails: [
      `Signature ref: ${group.signature.slice(0, 16)}`,
      `Persisted diagnosis ref: ${diagnosisId}`,
      `Summary: ${group.summary}`,
      `Severity: ${group.severity}`,
    ],
    evidenceLabel: 'Platform Feedback Metadata and Evidence Refs',
    evidence: [
      `Source: ${group.source}`,
      `Window: ${new Date(group.firstSeenAt).toISOString()} – ${new Date(group.lastSeenAt).toISOString()}`,
      `Matching errors in latest window: ${group.count}`,
      '',
      'Bounded evidence references:',
      refs || '- none',
    ].join('\n'),
  });
}
async function recordGroupFailure(
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

async function recordGroupBudgetDeferral(
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
        WHEN queue_state IN ('resolved', 'expired') THEN 'pending'
        ELSE queue_state
      END,
      queued_at = CASE
        WHEN rejected_at IS NOT NULL THEN queued_at
        WHEN queued_at IS NULL OR queue_state IN ('resolved', 'expired') THEN ?
        ELSE queued_at
      END,
      expired_at = CASE WHEN queue_state = 'expired' THEN NULL ELSE expired_at END,
      updated_at = CURRENT_TIMESTAMP
     WHERE signature = ? AND claim_token = ?`
  )
    .bind(deferredUntil, reason, now, reason, now, now, signature, claimToken)
    .run();
  return (result.meta.changes ?? 0) === 1;
}

async function excludeFeedbackProjectTaskErrors(
  env: Env,
  rows: ErrorRow[],
  feedbackProjectId: string
): Promise<ErrorRow[]> {
  const taskIds = [
    ...new Set(rows.map((row) => row.task_id).filter((id): id is string => Boolean(id))),
  ];
  if (taskIds.length === 0) return rows;
  const placeholders = taskIds.map(() => '?').join(', ');
  const query = await env.DATABASE.prepare(
    `SELECT id FROM tasks WHERE project_id = ? AND id IN (${placeholders})`
  )
    .bind(feedbackProjectId, ...taskIds)
    .all<{ id: string }>();
  const selfTaskIds = new Set((query.results ?? []).map((row) => row.id));
  return rows.filter((row) => !row.task_id || !selfTaskIds.has(row.task_id));
}

async function loadExistingTriageRows(
  env: Env,
  signatures: string[]
): Promise<Map<string, ExistingTriagePriorityRow>> {
  const rows = new Map<string, ExistingTriagePriorityRow>();
  for (let offset = 0; offset < signatures.length; offset += D1_MAX_BOUND_PARAMETERS) {
    const chunk = signatures.slice(offset, offset + D1_MAX_BOUND_PARAMETERS);
    if (chunk.length === 0) continue;
    const query = await env.DATABASE.prepare(
      `SELECT signature, diagnosis_id, idea_id, occurrence_count, severity,
        budget_deferred_until, rejected_at, queue_state
       FROM platform_feedback_triages
       WHERE signature IN (${chunk.map(() => '?').join(',')})`
    )
      .bind(...chunk)
      .all<ExistingTriagePriorityRow>();
    for (const row of query.results ?? []) rows.set(row.signature, row);
  }
  return rows;
}

async function loadDueBudgetDeferredGroups(
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

function prioritizeFeedbackGroups(
  groups: FeedbackErrorGroup[],
  existingRows: Map<string, ExistingTriagePriorityRow>,
  now: number
): FeedbackErrorGroup[] {
  return [...groups].sort((left, right) => {
    const leftExisting = existingRows.get(left.signature);
    const rightExisting = existingRows.get(right.signature);
    const leftEligible =
      !leftExisting?.budget_deferred_until || leftExisting.budget_deferred_until <= now ? 1 : 0;
    const rightEligible =
      !rightExisting?.budget_deferred_until || rightExisting.budget_deferred_until <= now ? 1 : 0;
    const eligibilityDelta = rightEligible - leftEligible;
    if (eligibilityDelta !== 0) return eligibilityDelta;

    const severityDelta = severityRank(right.severity) - severityRank(left.severity);
    if (severityDelta !== 0) return severityDelta;

    const leftNovel = leftExisting?.diagnosis_id || leftExisting?.idea_id ? 0 : 1;
    const rightNovel = rightExisting?.diagnosis_id || rightExisting?.idea_id ? 0 : 1;
    const noveltyDelta = rightNovel - leftNovel;
    if (noveltyDelta !== 0) return noveltyDelta;

    const leftOccurrences = leftExisting?.occurrence_count ?? left.count;
    const rightOccurrences = rightExisting?.occurrence_count ?? right.count;
    const repeatDelta = leftOccurrences - rightOccurrences;
    if (repeatDelta !== 0) return repeatDelta;

    return right.lastSeenAt - left.lastSeenAt;
  });
}
export async function runPlatformFeedbackTriage(
  env: Env,
  trigger: FeedbackTriageTrigger,
  deps: TriageDeps = {}
): Promise<FeedbackTriageResult> {
  const projectId = await configuredFeedbackProjectId(env);
  const base: FeedbackTriageResult = {
    enabled: Boolean(projectId),
    trigger,
    groupsFound: 0,
    ideasCreated: 0,
    ideasUpdated: 0,
    groupsSkipped: 0,
    groupsFailed: 0,
    groupsBudgetDeferred: 0,
    failureReasons: [],
  };
  if (!projectId) return base;
  const project = await env.DATABASE.prepare('SELECT id, user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ id: string; user_id: string }>();
  if (!project)
    throw new Error('Configured feedback project does not reference an existing project');
  const now = deps.now?.() ?? Date.now();
  const windowMinutes = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES
  );
  const errorLimit = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT
  );
  const groupLimit = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT
  );
  const evidenceLimit = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT
  );
  const claimTtl = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS
  );
  const maxFailures = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_MAX_FAILURES
  );
  const budgetDeferMs = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_BUDGET_DEFER_MS
  );
  const failureReasonMaxLength = positive(
    env.PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_FAILURE_REASON_MAX_LENGTH
  );
  const query = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT id, source, level, message, timestamp, task_id
     FROM platform_errors
     WHERE level IN ('error', 'warn') AND timestamp BETWEEN ? AND ?
     ORDER BY timestamp DESC LIMIT ?`
  )
    .bind(now - windowMinutes * 60_000, now, errorLimit)
    .all<ErrorRow>();
  const candidateRows = await excludeFeedbackProjectTaskErrors(
    env,
    query.results ?? [],
    project.id
  );
  const grouped = await groupPlatformErrors(candidateRows, evidenceLimit);
  const dueBudgetDeferred = await loadDueBudgetDeferredGroups(
    env,
    now,
    new Set(grouped.map((group) => group.signature)),
    groupLimit,
    evidenceLimit
  );
  const candidateGroups = [...grouped, ...dueBudgetDeferred];
  const existingPriorityRows = await loadExistingTriageRows(
    env,
    candidateGroups.map((group) => group.signature)
  );
  const groups = prioritizeFeedbackGroups(candidateGroups, existingPriorityRows, now).slice(
    0,
    groupLimit
  );
  const result = { ...base, groupsFound: groups.length };
  const diagnose = deps.diagnose ?? runDebugDiagnosis;

  for (const [index, group] of groups.entries()) {
    const refs = JSON.stringify(group.evidence);
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO platform_feedback_triages
      (signature, source, summary, first_seen_at, last_seen_at, occurrence_count, evidence_refs,
       severity, queue_state, queued_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`
    )
      .bind(
        group.signature,
        group.source,
        group.summary,
        group.firstSeenAt,
        group.lastSeenAt,
        group.count,
        refs,
        group.severity,
        now
      )
      .run();
    await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET first_seen_at = MIN(first_seen_at, ?),
      last_seen_at = MAX(last_seen_at, ?), occurrence_count = MAX(occurrence_count, ?),
      evidence_refs = ?,
      severity = CASE WHEN ? = 'error' THEN 'error' ELSE severity END,
      queue_state = CASE
        WHEN rejected_at IS NOT NULL THEN 'rejected'
        WHEN queue_state IN ('resolved', 'expired') THEN 'pending'
        ELSE queue_state
      END,
      queued_at = CASE
        WHEN rejected_at IS NOT NULL THEN queued_at
        WHEN queued_at IS NULL OR queue_state IN ('resolved', 'expired') THEN ?
        ELSE queued_at
      END,
      expired_at = CASE WHEN queue_state = 'expired' THEN NULL ELSE expired_at END,
      updated_at = CURRENT_TIMESTAMP WHERE signature = ?`
    )
      .bind(
        group.firstSeenAt,
        group.lastSeenAt,
        group.count,
        refs,
        group.severity,
        now,
        group.signature
      )
      .run();
    await markIncidentPending(env, group.signature, now);
    const existing = await env.DATABASE.prepare(
      `SELECT t.idea_id, t.diagnosis_id, t.rejected_at, t.budget_deferred_until
       FROM platform_feedback_triages t
      WHERE t.signature = ?`
    )
      .bind(group.signature)
      .first<{
        idea_id: string | null;
        diagnosis_id: string | null;
        rejected_at: number | null;
        budget_deferred_until: number | null;
      }>();
    if (existing?.rejected_at) {
      result.groupsSkipped += 1;
      continue;
    }
    if (existing?.idea_id) {
      const update = await env.DATABASE.prepare(
        `UPDATE tasks SET description = ?, updated_at = ?
        WHERE id = ? AND project_id = ? AND status = 'draft'`
      )
        .bind(
          ideaDescription(group, existing.diagnosis_id ?? 'pending'),
          new Date(now).toISOString(),
          existing.idea_id,
          project.id
        )
        .run();
      if ((update.meta.changes ?? 0) === 1) {
        result.ideasUpdated += 1;
      } else {
        // The triage row remains the bounded diagnosis annotation when the linked Idea was promoted/deleted.
        result.groupsSkipped += 1;
      }
      continue;
    }
    if (existing?.budget_deferred_until && existing.budget_deferred_until > now) {
      result.groupsSkipped += 1;
      continue;
    }
    const claimToken = ulid();
    const claim = await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET
        failure_count = CASE WHEN claim_expires_at IS NOT NULL AND claim_expires_at < ? THEN failure_count + 1 ELSE failure_count END,
        last_failure_reason = CASE WHEN claim_expires_at IS NOT NULL AND claim_expires_at < ? THEN ? ELSE last_failure_reason END,
        last_failed_at = CASE WHEN claim_expires_at IS NOT NULL AND claim_expires_at < ? THEN ? ELSE last_failed_at END,
        claim_token = ?,
        claim_expires_at = ?,
        updated_at = CURRENT_TIMESTAMP
      WHERE signature = ? AND idea_id IS NULL AND rejected_at IS NULL AND failure_count < ?
        AND (budget_deferred_until IS NULL OR budget_deferred_until <= ?)
        AND (claim_expires_at IS NULL OR claim_expires_at < ?)`
    )
      .bind(
        now,
        now,
        'stale claim reclaimed after lease expiry',
        now,
        now,
        claimToken,
        now + claimTtl,
        group.signature,
        maxFailures,
        now,
        now
      )
      .run();
    if ((claim.meta.changes ?? 0) !== 1) {
      result.groupsSkipped += 1;
      continue;
    }
    try {
      const representative = group.evidence[0];
      if (!representative) {
        await recordGroupFailure(
          env,
          group.signature,
          claimToken,
          now,
          maxFailures,
          'group had no representative evidence'
        );
        result.groupsFailed += 1;
        result.failureReasons.push('group had no representative evidence');
        continue;
      }
      const diagnosis = await diagnose(
        env,
        project.user_id,
        { errorId: representative.errorId },
        { featureKey: SCHEDULED_TRIAGE_DEBUG_FEATURE_KEY }
      );
      const ideaId = ulid();
      const isoNow = new Date(now).toISOString();
      const committed = await env.DATABASE.batch([
        env.DATABASE.prepare(
          `INSERT INTO tasks (id, project_id, user_id, title, description, status, priority,
          task_mode, dispatch_depth, created_by, created_at, updated_at)
          SELECT ?, ?, ?, ?, ?, 'draft', 0, 'task', 0, ?, ?, ?
          WHERE EXISTS (SELECT 1 FROM platform_feedback_triages
          WHERE signature = ? AND claim_token = ? AND idea_id IS NULL)`
        ).bind(
          ideaId,
          project.id,
          project.user_id,
          group.summary.slice(0, 200),
          ideaDescription(group, diagnosis.id),
          project.user_id,
          isoNow,
          isoNow,
          group.signature,
          claimToken
        ),
        env.DATABASE.prepare(
          `UPDATE platform_feedback_triages SET diagnosis_id = ?, idea_id = ?, claim_token = NULL,
          claim_expires_at = NULL, budget_deferred_until = NULL, budget_deferred_reason = NULL,
          updated_at = CURRENT_TIMESTAMP WHERE signature = ? AND claim_token = ?`
        ).bind(diagnosis.id, ideaId, group.signature, claimToken),
      ]);
      const insertChanges = committed[0]?.meta.changes ?? 0;
      const linkChanges = committed[1]?.meta.changes ?? 0;
      if (insertChanges === 1 && linkChanges === 1) {
        result.ideasCreated += 1;
      } else if (insertChanges === 0 && linkChanges === 0) {
        result.groupsSkipped += 1;
      } else {
        throw new Error('Platform feedback triage claim commit was inconsistent');
      }
    } catch (cause) {
      const reason = sanitizeFailureReason(cause, failureReasonMaxLength);
      const budgetBlock = classifyBudgetBlock(reason);
      if (budgetBlock) {
        const deferredUntil = budgetBlock === 'daily' ? nextUtcDayStart(now) : now + budgetDeferMs;
        const recorded = await recordGroupBudgetDeferral(
          env,
          group.signature,
          claimToken,
          now,
          reason,
          deferredUntil
        );
        if (recorded) result.groupsBudgetDeferred += 1;
        else result.groupsSkipped += 1;
        log.warn('platform-feedback-triage.group-budget-deferred', {
          trigger,
          signature: group.signature.slice(0, 16),
          reason,
          deferredUntil,
        });
        if (budgetBlock === 'daily') {
          result.groupsSkipped += groups.length - index - 1;
          break;
        }
        continue;
      }
      const marked = await recordGroupFailure(
        env,
        group.signature,
        claimToken,
        now,
        maxFailures,
        reason
      );
      result.groupsFailed += 1;
      result.failureReasons.push(reason);
      log.warn('platform-feedback-triage.group-failed', {
        trigger,
        signature: group.signature.slice(0, 16),
        reason,
        rejected: marked.rejected,
      });
    }
  }
  return result;
}
