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

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { ulid } from '../../lib/ulid';
import { runDebugDiagnosis, SCHEDULED_TRIAGE_DEBUG_FEATURE_KEY } from '../debug-agent';
import { configuredFeedbackProjectId } from '../platform-feedback-incidents';
import {
  classifyBudgetBlock,
  groupPlatformErrors,
  ideaDescription,
  nextUtcDayStart,
  sanitizeFailureReason,
} from './grouping';
import { positive } from './numbers';
import {
  annotateNodeAgentVersions,
  excludeFeedbackProjectTaskErrors,
  loadDueBudgetDeferredGroups,
  loadExistingTriageRows,
  readExistingTriageRow,
  recordGroupBudgetDeferral,
  recordGroupFailure,
} from './persistence';
import { prioritizeFeedbackGroups, shouldReopenExistingTriage } from './prioritization';
import type { ErrorRow, FeedbackTriageResult, FeedbackTriageTrigger, TriageDeps } from './types';

const DEFAULT_PLATFORM_FEEDBACK_TRIAGE_IDEA_TITLE_MAX_LENGTH = 200;

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
  const ideaTitleMaxLength = positive(
    env.SAM_IDEA_TITLE_MAX_LENGTH,
    DEFAULT_PLATFORM_FEEDBACK_TRIAGE_IDEA_TITLE_MAX_LENGTH
  );
  const query = await env.OBSERVABILITY_DATABASE.prepare(
    `SELECT id, source, level, message, timestamp, task_id, node_id
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
  const rowsWithAgentVersions = await annotateNodeAgentVersions(env, candidateRows);
  const grouped = await groupPlatformErrors(rowsWithAgentVersions, evidenceLimit);
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
    const latestExisting = await readExistingTriageRow(env, group.signature);
    const reopenTerminal = shouldReopenExistingTriage(
      env,
      latestExisting ?? existingPriorityRows.get(group.signature),
      group
    );
    await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET first_seen_at = MIN(first_seen_at, ?),
      last_seen_at = MAX(last_seen_at, ?), occurrence_count = MAX(occurrence_count, ?),
      evidence_refs = ?,
      severity = CASE WHEN ? = 'error' THEN 'error' ELSE severity END,
      queue_state = CASE
        WHEN rejected_at IS NOT NULL THEN 'rejected'
        WHEN queue_state IN ('resolved', 'expired') AND ? THEN 'pending'
        ELSE queue_state
      END,
      queued_at = CASE
        WHEN rejected_at IS NOT NULL THEN queued_at
        WHEN queue_state IN ('resolved', 'expired') AND ? THEN ?
        WHEN queued_at IS NULL AND queue_state NOT IN ('resolved', 'expired') THEN ?
        ELSE queued_at
      END,
      expired_at = CASE WHEN queue_state = 'expired' AND ? THEN NULL ELSE expired_at END,
      updated_at = CURRENT_TIMESTAMP WHERE signature = ?`
    )
      .bind(
        group.firstSeenAt,
        group.lastSeenAt,
        group.count,
        refs,
        group.severity,
        reopenTerminal ? 1 : 0,
        reopenTerminal ? 1 : 0,
        now,
        now,
        reopenTerminal ? 1 : 0,
        group.signature
      )
      .run();
    if (
      latestExisting &&
      ['resolved', 'expired'].includes(latestExisting.queue_state ?? '') &&
      !reopenTerminal
    ) {
      result.groupsSkipped += 1;
      continue;
    }
    const existing = await env.DATABASE.prepare(
      `SELECT t.idea_id, t.diagnosis_id, t.rejected_at, t.budget_deferred_until, t.queue_state
       FROM platform_feedback_triages t
      WHERE t.signature = ?`
    )
      .bind(group.signature)
      .first<{
        idea_id: string | null;
        diagnosis_id: string | null;
        rejected_at: number | null;
        budget_deferred_until: number | null;
        queue_state: string | null;
      }>();
    if (existing?.rejected_at) {
      result.groupsSkipped += 1;
      continue;
    }
    if (['resolved', 'expired'].includes(existing?.queue_state ?? '')) {
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
        AND queue_state = 'pending'
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
          group.summary.slice(0, ideaTitleMaxLength),
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
