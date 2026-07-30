import {
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_CLAIM_TTL_MS,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_ERROR_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_EVIDENCE_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_GROUP_LIMIT,
  DEFAULT_PLATFORM_FEEDBACK_TRIAGE_WINDOW_MINUTES,
} from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { ulid } from '../lib/ulid';
import { runDebugDiagnosis, SCHEDULED_TRIAGE_DEBUG_FEATURE_KEY } from './debug-agent';
import { redactSensitiveData } from './observability';
import { formatUntrustedIdeaContent } from './untrusted-idea-content';

export type FeedbackTriageTrigger = 'cron' | 'manual';
export interface FeedbackTriageResult {
  enabled: boolean;
  trigger: FeedbackTriageTrigger;
  groupsFound: number;
  ideasCreated: number;
  ideasUpdated: number;
  groupsSkipped: number;
}
interface ErrorRow {
  id: string;
  source: string;
  message: string;
  timestamp: number;
}
export interface FeedbackErrorGroup {
  signature: string;
  source: string;
  summary: string;
  firstSeenAt: number;
  lastSeenAt: number;
  evidence: Array<{ errorId: string; timestamp: number }>;
  count: number;
}
interface TriageDeps {
  now?: () => number;
  diagnose?: typeof runDebugDiagnosis;
}

function positive(value: string | undefined, fallback: number): number {
  const parsed = Number.parseInt(value ?? '', 10);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
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
      current.firstSeenAt = Math.min(current.firstSeenAt, row.timestamp);
      current.lastSeenAt = Math.max(current.lastSeenAt, row.timestamp);
      if (current.evidence.length < evidenceLimit) current.evidence.push(evidence);
    } else {
      groups.set(key, {
        source,
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
export async function runPlatformFeedbackTriage(
  env: Env,
  trigger: FeedbackTriageTrigger,
  deps: TriageDeps = {}
): Promise<FeedbackTriageResult> {
  const projectId = env.PLATFORM_FEEDBACK_PROJECT_ID?.trim();
  const base: FeedbackTriageResult = {
    enabled: Boolean(projectId),
    trigger,
    groupsFound: 0,
    ideasCreated: 0,
    ideasUpdated: 0,
    groupsSkipped: 0,
  };
  if (!projectId) return base;
  const project = await env.DATABASE.prepare('SELECT id, user_id FROM projects WHERE id = ?')
    .bind(projectId)
    .first<{ id: string; user_id: string }>();
  if (!project)
    throw new Error('PLATFORM_FEEDBACK_PROJECT_ID does not reference an existing project');
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
  const query = await env.OBSERVABILITY_DATABASE.prepare(
    'SELECT id, source, message, timestamp FROM platform_errors WHERE level = ? AND timestamp BETWEEN ? AND ? ORDER BY timestamp DESC LIMIT ?'
  )
    .bind('error', now - windowMinutes * 60_000, now, errorLimit)
    .all<ErrorRow>();
  const groups = (await groupPlatformErrors(query.results ?? [], evidenceLimit))
    .sort((a, b) => b.count - a.count || b.lastSeenAt - a.lastSeenAt)
    .slice(0, groupLimit);
  const result = { ...base, groupsFound: groups.length };
  const diagnose = deps.diagnose ?? runDebugDiagnosis;

  for (const group of groups) {
    const refs = JSON.stringify(group.evidence);
    await env.DATABASE.prepare(
      `INSERT OR IGNORE INTO platform_feedback_triages
      (signature, source, summary, first_seen_at, last_seen_at, occurrence_count, evidence_refs)
      VALUES (?, ?, ?, ?, ?, ?, ?)`
    )
      .bind(
        group.signature,
        group.source,
        group.summary,
        group.firstSeenAt,
        group.lastSeenAt,
        group.count,
        refs
      )
      .run();
    await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET first_seen_at = MIN(first_seen_at, ?),
      last_seen_at = MAX(last_seen_at, ?), occurrence_count = MAX(occurrence_count, ?), evidence_refs = ?,
      updated_at = CURRENT_TIMESTAMP WHERE signature = ?`
    )
      .bind(group.firstSeenAt, group.lastSeenAt, group.count, refs, group.signature)
      .run();
    const existing = await env.DATABASE.prepare(
      `SELECT t.idea_id, t.diagnosis_id FROM platform_feedback_triages t
      WHERE t.signature = ?`
    )
      .bind(group.signature)
      .first<{ idea_id: string | null; diagnosis_id: string | null }>();
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
    const claimToken = ulid();
    const claim = await env.DATABASE.prepare(
      `UPDATE platform_feedback_triages SET claim_token = ?, claim_expires_at = ?
      WHERE signature = ? AND idea_id IS NULL AND (claim_expires_at IS NULL OR claim_expires_at < ?)`
    )
      .bind(claimToken, now + claimTtl, group.signature, now)
      .run();
    if ((claim.meta.changes ?? 0) !== 1) {
      result.groupsSkipped += 1;
      continue;
    }
    try {
      const representative = group.evidence[0];
      if (!representative) {
        result.groupsSkipped += 1;
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
          claim_expires_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE signature = ? AND claim_token = ?`
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
      await env.DATABASE.prepare(
        'UPDATE platform_feedback_triages SET claim_token = NULL, claim_expires_at = NULL WHERE signature = ? AND claim_token = ?'
      )
        .bind(group.signature, claimToken)
        .run();
      throw cause;
    }
  }
  return result;
}
