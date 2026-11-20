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

const SEMANTIC_JSON_KEYS = new Set(['code', 'error', 'message', 'name', 'reason', 'type']);

function normalizeLegacyMessage(message: string): string {
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

/**
 * Replaces variable tokens (ids, urls, numbers, durations, quoted values) with placeholders.
 * The signature uses the lowercased form; readable titles keep the original case
 * (`lowercase: false`). Every pattern is case-insensitive, so both forms replace the same tokens.
 */
function normalizeTextTokens(
  value: string,
  normalizeQuotedValues = true,
  lowercase = true
): string {
  let normalized = (lowercase ? value.toLowerCase() : value)
    .replace(/https?:\/\/\S+/gi, '[url]')
    .replace(/\b[a-z0-9.!#$%&*+/=?^_`{|}~-]+@[a-z0-9.-]+\.[a-z]{2,}\b/gi, '[email]')
    .replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]')
    .replace(/\b\d{4}-\d{2}-\d{2}[t ]\d{2}:\d{2}:\d{2}(?:\.\d+)?z?\b/gi, '[timestamp]')
    .replace(/\b[0-9a-hjkmnp-tv-z]{26}\b/gi, '[id]')
    .replace(
      /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/gi,
      '[id]'
    )
    .replace(/\b(?:0x)?[0-9a-f]{8,}\b/gi, '[id]')
    .replace(/\b\d+(?:\.\d+)?\s*(?:ns|us|µs|ms|s|m|h|d)\b/gi, '[duration]')
    .replace(/\b\d+(?:\.\d+)?\s*secs?\b/gi, '[duration]')
    .replace(/\b\d+(?:\.\d+)?\s*(?:seconds?|minutes?|hours?|days?)\b/gi, '[duration]')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?\b/g, '[duration]')
    .replace(/(?<![a-z0-9_])[-+]?\d+(?:\.\d+)?(?:e[-+]?\d+)?(?![a-z0-9_])/gi, '[n]');
  if (normalizeQuotedValues) {
    normalized = normalized
      .replace(/"(?:\\.|[^"\\])*"/g, '[quoted]')
      .replace(/'(?:\\.|[^'\\])*'/g, '[quoted]');
  }
  return normalized.replace(/\s+/g, ' ').trim();
}

function jsonShape(value: unknown, key?: string): string {
  if (value === null) return '[null]';
  if (Array.isArray(value)) {
    const shapes = [...new Set(value.map((item) => jsonShape(item)))].sort((left, right) =>
      left.localeCompare(right)
    );
    return `[${shapes.join(',')}]`;
  }
  if (typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(
        ([entryKey, entryValue]) =>
          `${normalizeTextTokens(entryKey, false)}:${jsonShape(entryValue, entryKey)}`
      )
      .join(',')}}`;
  }
  if (typeof value === 'string') {
    return key && SEMANTIC_JSON_KEYS.has(key.toLowerCase())
      ? normalizeTextTokens(value, false)
      : '[string]';
  }
  if (typeof value === 'number') return '[n]';
  if (typeof value === 'boolean') return '[boolean]';
  return `[${typeof value}]`;
}

interface JsonStringScanState {
  escaped: boolean;
  inString: boolean;
}

function consumeJsonStringCharacter(character: string, state: JsonStringScanState): boolean {
  if (!state.inString) {
    if (character !== '"') return false;
    state.inString = true;
    return true;
  }
  if (state.escaped) state.escaped = false;
  else if (character === '\\') state.escaped = true;
  else if (character === '"') state.inString = false;
  return true;
}

function findEmbeddedJsonEnd(value: string, start: number, opener: '{' | '['): number | null {
  const closer = opener === '{' ? '}' : ']';
  const stringState: JsonStringScanState = { escaped: false, inString: false };
  let depth = 0;
  for (let end = start; end < value.length; end += 1) {
    const character = value.charAt(end);
    if (consumeJsonStringCharacter(character, stringState)) continue;
    if (character === opener) depth += 1;
    if (character !== closer) continue;
    depth -= 1;
    if (depth === 0) return end;
  }
  return null;
}

function parsedJsonShape(candidate: string): string | null {
  try {
    return jsonShape(JSON.parse(candidate));
  } catch {
    return null;
  }
}

function normalizeEmbeddedJson(value: string): string {
  let result = '';
  let index = 0;
  while (index < value.length) {
    const opener = value[index];
    if (opener !== '{' && opener !== '[') {
      result += opener;
      index += 1;
      continue;
    }
    const end = findEmbeddedJsonEnd(value, index, opener);
    const shape = end === null ? null : parsedJsonShape(value.slice(index, end + 1));
    result += shape ?? opener;
    index = shape === null || end === null ? index + 1 : end + 1;
  }
  return result;
}

function normalizeMessage(message: string): string {
  const redacted = String(redactSensitiveData(message));
  return normalizeTextTokens(normalizeEmbeddedJson(redacted)).slice(
    0,
    PLATFORM_ERROR_MESSAGE_GROUP_MAX_LENGTH
  );
}

/** Idea title cap when `SAM_IDEA_TITLE_MAX_LENGTH` is unset. */
export const DEFAULT_PLATFORM_FEEDBACK_TRIAGE_IDEA_TITLE_MAX_LENGTH = 200;

/** Longest readable incident summary (idea title, queue summary, triage prompt line). */
export const DEFAULT_PLATFORM_FEEDBACK_SUMMARY_MAX_LENGTH = 140;

/** The pre-2026-11 summary every machine-grouped incident shared. */
const LEGACY_GENERIC_SUMMARY = /^Recurring [a-z-]+ platform error$/;

export function isLegacyGenericSummary(summary: string | null | undefined): boolean {
  return LEGACY_GENERIC_SUMMARY.test(summary ?? '');
}

/** `password=…`, `api_key: …`, `client-secret=…`: a value after a secret-named key. */
const SECRET_ASSIGNMENT =
  /\b(password|passwd|pwd|secret|token|api[_-]?key|apikey|access[_-]?key|private[_-]?key|client[_-]?secret|credentials?)(\s*[:=]\s*)(?!\[)\S+/gi;
const BEARER_VALUE = /\b(bearer|basic)\s+(?!\[)[A-Za-z0-9._~+/=-]{8,}/gi;
/** A long run mixing letters and digits: provider tokens with no known prefix. */
const UNSHAPED_TOKEN =
  /(?<![A-Za-z0-9_-])(?=[A-Za-z0-9_-]*[A-Za-z])(?=[A-Za-z0-9_-]*\d)[A-Za-z0-9_-]{24,}(?![A-Za-z0-9_-])/g;

/**
 * Extra scrubbing for text that becomes an idea title or body. `redactSensitiveData` knows
 * secret formats with a recognisable shape; a token with no known prefix (Hetzner, Vultr) or a
 * `password=…` pair would otherwise survive into a durable, searchable title. Not applied to
 * the signature, so grouping is unchanged.
 */
function scrubUnshapedSecrets(value: string): string {
  return value
    .replace(SECRET_ASSIGNMENT, '$1$2[redacted]')
    .replace(BEARER_VALUE, '$1 [redacted]')
    .replace(UNSHAPED_TOKEN, '[id]');
}

/**
 * The redacted, normalized message in its original case: the same redaction and token
 * placeholders as the signature, so it never carries ids, urls, emails, numbers or quoted
 * values. Control characters are dropped because it becomes an idea title.
 */
export function displayPlatformErrorMessage(message: string): string {
  const redacted = String(redactSensitiveData(message));
  const printable = Array.from(normalizeTextTokens(normalizeEmbeddedJson(redacted), true, false))
    .map((ch) => {
      const code = ch.codePointAt(0) ?? 0;
      return code < 32 || code === 127 ? ' ' : ch;
    })
    .join('');
  return (
    scrubUnshapedSecrets(printable)
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, PLATFORM_ERROR_MESSAGE_GROUP_MAX_LENGTH) || 'redacted platform error'
  );
}

/** `<source>: <message>`, bounded, e.g. `api: Failed to destroy max-lifetime node: …`. */
export function platformErrorSummary(
  source: string,
  displayMessage: string,
  maxLength: number = DEFAULT_PLATFORM_FEEDBACK_SUMMARY_MAX_LENGTH
): string {
  // Backticks would open code spans or fences wherever a title is rendered as markdown.
  const full = `${source}: ${displayMessage.replace(/`+/g, "'")}`;
  if (full.length <= maxLength) return full;
  return `${full.slice(0, Math.max(1, maxLength - 1)).trimEnd()}…`;
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
/** The source and normalized message a platform error is grouped by. */
function platformErrorGroupKey(
  rawSource: string,
  message: string
): { source: string; key: string } {
  const candidateSource = rawSource.trim().toLowerCase();
  const source = ALLOWED_ERROR_SOURCES.has(candidateSource) ? candidateSource : 'unknown';
  const normalized = normalizeMessage(message) || 'redacted platform error';
  return { source, key: `${source}\n${normalized}` };
}

/**
 * The triage signature (`platform_feedback_triages.signature`) the hourly triage gives every
 * error with this source and message. Lets a reader find the incident for a known error, such as
 * the lifecycle latency watchdog's, without restating the grouping.
 */
export async function platformErrorSignature(source: string, message: string): Promise<string> {
  return digest(platformErrorGroupKey(source, message).key);
}

export async function groupPlatformErrors(
  rows: ErrorRow[],
  evidenceLimit: number
): Promise<FeedbackErrorGroup[]> {
  const groups = new Map<
    string,
    Omit<FeedbackErrorGroup, 'signature' | 'canonicalSignature' | 'legacySignatures'> & {
      legacyKeys: Set<string>;
    }
  >();
  for (const row of rows) {
    const { source, key } = platformErrorGroupKey(row.source, row.message);
    const severity = normalizeSeverity(row.level);
    const legacyNormalized = normalizeLegacyMessage(row.message) || 'redacted platform error';
    const legacyKey = `${source}\n${legacyNormalized}`;
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
      current.legacyKeys.add(legacyKey);
      current.count += 1;
      current.severity =
        severityRank(severity) > severityRank(current.severity) ? severity : current.severity;
      current.firstSeenAt = Math.min(current.firstSeenAt, row.timestamp);
      current.lastSeenAt = Math.max(current.lastSeenAt, row.timestamp);
      if (current.evidence.length < evidenceLimit) current.evidence.push(evidence);
      current.occurrences?.push({ id: row.id, timestamp: row.timestamp });
    } else {
      const message = displayPlatformErrorMessage(row.message);
      groups.set(key, {
        source,
        severity,
        summary: platformErrorSummary(source, message),
        message,
        firstSeenAt: row.timestamp,
        lastSeenAt: row.timestamp,
        evidence: [evidence],
        count: 1,
        occurrences: [{ id: row.id, timestamp: row.timestamp }],
        legacyKeys: new Set([legacyKey]),
      });
    }
  }
  return Promise.all(
    [...groups.entries()].map(async ([key, group]) => {
      const { legacyKeys, ...storedGroup } = group;
      const signature = await digest(key);
      const legacySignatures = await Promise.all([...legacyKeys].map(digest));
      return {
        ...storedGroup,
        signature,
        canonicalSignature: signature,
        legacySignatures: legacySignatures.filter((legacy) => legacy !== signature),
      };
    })
  );
}
export interface IdeaOccurrenceStats {
  /**
   * Occurrences stored for the incident: the largest single window while it is open, and a
   * running total while it is watched (`recordWatchedRecurrence`).
   */
  occurrenceCount: number;
  firstSeenAt: number;
  lastSeenAt: number;
  /** Present while the incident is watched or after a spike returned it to triage. */
  watch?: IdeaWatchStats;
}

export interface IdeaWatchStats {
  watching: boolean;
  watchingSince: number | null;
  /** Agent-written; rendered inside the untrusted evidence block. */
  reason: string | null;
  recentOccurrenceCount: number;
  recentWindowHours: number;
  escalationReason: string | null;
}

function watchDetails(watch: IdeaWatchStats | undefined): string[] {
  if (!watch) return [];
  return [
    watch.watching
      ? `Disposition: watching since ${watch.watchingSince ? new Date(watch.watchingSince).toISOString() : 'unknown'} (recurrences update these counts; no re-triage)`
      : 'Disposition: returned from watching to triage',
    `Occurrences in the last ${watch.recentWindowHours}h while watching: ${watch.recentOccurrenceCount}`,
    ...(watch.escalationReason ? [`Latest spike: ${watch.escalationReason}`] : []),
  ];
}

/**
 * The body of an incident's idea. The normalized message and counts are what a reader needs to
 * decide whether the signature matters; the error ids let an operator pull the raw records.
 * The message is log-derived, so it stays inside the untrusted evidence block.
 */
export function ideaDescription(
  group: FeedbackErrorGroup,
  diagnosisId: string,
  stats: IdeaOccurrenceStats = {
    occurrenceCount: group.count,
    firstSeenAt: group.firstSeenAt,
    lastSeenAt: group.lastSeenAt,
  }
): string {
  const refs = group.evidence
    .map((item) => `- ${item.errorId} at ${new Date(item.timestamp).toISOString()}`)
    .join('\n');

  return formatUntrustedIdeaContent({
    trustedSummary:
      'Automated platform error report, one idea per error signature. Raw observability messages were redacted and normalized (ids, urls, numbers and quoted values replaced) before grouping. Read the incident with get_incident; the incident triage closes this idea when the incident is resolved, rejected or expires.',
    trustedDetails: [
      `Signature ref: ${group.signature.slice(0, 16)}`,
      `Persisted diagnosis ref: ${diagnosisId}`,
      `Severity: ${group.severity}`,
      `Occurrences: ${stats.occurrenceCount}`,
      `First seen: ${new Date(stats.firstSeenAt).toISOString()}`,
      `Last seen: ${new Date(stats.lastSeenAt).toISOString()}`,
      ...watchDetails(stats.watch),
    ],
    evidenceLabel: 'Normalized Error Signature and Evidence Refs',
    evidence: [
      `Source: ${group.source}`,
      `Normalized message: ${group.message ?? group.summary}`,
      `Latest window: ${new Date(group.firstSeenAt).toISOString()} – ${new Date(group.lastSeenAt).toISOString()} (${group.count} errors)`,
      '',
      'Bounded evidence references:',
      refs || '- none',
      ...(stats.watch?.reason ? ['', `Watch reason (agent-written): ${stats.watch.reason}`] : []),
    ].join('\n'),
  });
}
