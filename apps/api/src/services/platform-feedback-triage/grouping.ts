import { redactSensitiveData } from '../observability';
import { formatUntrustedIdeaContent } from '../untrusted-idea-content';
import type {
  ErrorRow,
  FeedbackErrorEvidence,
  FeedbackErrorGroup,
  FeedbackSeverity,
} from './types';

const PLATFORM_ERROR_MESSAGE_GROUP_MAX_LENGTH = 500;

export function sanitizeFailureReason(cause: unknown, maxLength: number): string {
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
export function normalizeSeverity(level: string | null | undefined): FeedbackSeverity {
  return level === 'warn' ? 'warn' : 'error';
}

export function severityRank(severity: string | null | undefined): number {
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
    .slice(0, PLATFORM_ERROR_MESSAGE_GROUP_MAX_LENGTH);
}

export function parseStoredEvidenceRefs(
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
        const nodeId = typeof record.nodeId === 'string' ? record.nodeId.trim() : '';
        const nodeAgentVersion =
          typeof record.nodeAgentVersion === 'string' ? record.nodeAgentVersion.trim() : '';
        const evidence: FeedbackErrorEvidence = {
          errorId: record.errorId,
          timestamp: record.timestamp,
          ...(nodeId ? { nodeId } : {}),
          ...(nodeAgentVersion ? { nodeAgentVersion } : {}),
        };
        return evidence;
      })
      .filter((item): item is FeedbackErrorEvidence => item !== null)
      .slice(0, evidenceLimit);
  } catch {
    return [];
  }
}

export function classifyBudgetBlock(reason: string): 'daily' | 'per-run' | null {
  if (reason === 'Daily deployment debugging budget exhausted') return 'daily';
  if (reason === 'Per-run debugging token ceiling reached') return 'per-run';
  return null;
}

export function nextUtcDayStart(now: number): number {
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
    const nodeId = row.node_id?.trim();
    const nodeAgentVersion = row.nodeAgentVersion?.trim();
    const evidence: FeedbackErrorEvidence = {
      errorId: safeErrorId,
      timestamp: row.timestamp,
      ...(nodeId ? { nodeId } : {}),
      ...(nodeAgentVersion ? { nodeAgentVersion } : {}),
    };
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
export function ideaDescription(group: FeedbackErrorGroup, diagnosisId: string): string {
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
