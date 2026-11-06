/**
 * SAM notices: the structured, server-written description of a message SAM injected into a
 * chat (a subtask finished, another agent wrote, an approval was decided). The server stores
 * it in `chat_messages.tool_metadata[SAM_NOTICE_METADATA_KEY]`; the UI renders it as a compact
 * row with entity cards. The message text itself stays what the agent received and is never
 * parsed to build the notice.
 */

export const SAM_NOTICE_VERSION = 1;

/** Key under `tool_metadata`. Only the server may write it; ingress paths strip it. */
export const SAM_NOTICE_METADATA_KEY = 'samNotice';

/** `warning` renders amber, which SAM reserves for things waiting on the human. */
export const SAM_NOTICE_SEVERITIES = ['info', 'success', 'warning', 'error'] as const;
export type SamNoticeSeverity = (typeof SAM_NOTICE_SEVERITIES)[number];

export const SAM_NOTICE_REF_KINDS = [
  'task',
  'session',
  'idea',
  'pull_request',
  'commit',
  'approval',
  'node',
  'schedule',
  'event',
] as const;
export type SamNoticeRefKind = (typeof SAM_NOTICE_REF_KINDS)[number];

/** Something the notice is about. `label`/`status` are a snapshot from when it was written. */
export interface SamNoticeRef {
  kind: SamNoticeRefKind;
  id: string;
  label?: string | null;
  status?: string | null;
  /** External page (GitHub). http(s) only. */
  url?: string | null;
}

/** Text that came from outside SAM (another agent, GitHub). Rendered quoted, never as SAM's words. */
export interface SamNoticeQuote {
  from: string;
  text: string;
}

export interface SamNotice {
  v: typeof SAM_NOTICE_VERSION;
  /** Dotted type, e.g. `subtask.completed`, `agent.message`. Unknown types still render. */
  type: string;
  /** One plain sentence a human understands without the IDs. */
  headline: string;
  detail?: string | null;
  severity: SamNoticeSeverity;
  refs: SamNoticeRef[];
  quote?: SamNoticeQuote | null;
}

/** Payload bounds. Notices are display data; anything longer is cut, never rejected. */
export const SAM_NOTICE_LIMITS = {
  typeChars: 64,
  headlineChars: 200,
  detailChars: 600,
  quoteFromChars: 120,
  quoteTextChars: 2000,
  refs: 8,
  refIdChars: 200,
  refLabelChars: 200,
  refStatusChars: 40,
  refUrlChars: 2048,
} as const;

function clampText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function safeHttpUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > SAM_NOTICE_LIMITS.refUrlChars) return null;
  try {
    const url = new URL(value);
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null;
  } catch {
    return null;
  }
}

function isRefKind(value: unknown): value is SamNoticeRefKind {
  return (SAM_NOTICE_REF_KINDS as readonly unknown[]).includes(value);
}

function isSeverity(value: unknown): value is SamNoticeSeverity {
  return (SAM_NOTICE_SEVERITIES as readonly unknown[]).includes(value);
}

function normalizeRef(value: unknown): SamNoticeRef | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (!isRefKind(record.kind)) return null;
  const id = clampText(record.id, SAM_NOTICE_LIMITS.refIdChars);
  if (!id) return null;
  return {
    kind: record.kind,
    id,
    label: clampText(record.label, SAM_NOTICE_LIMITS.refLabelChars),
    status: clampText(record.status, SAM_NOTICE_LIMITS.refStatusChars),
    url: safeHttpUrl(record.url),
  };
}

function normalizeQuote(value: unknown): SamNoticeQuote | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const from = clampText(record.from, SAM_NOTICE_LIMITS.quoteFromChars);
  const text = clampText(record.text, SAM_NOTICE_LIMITS.quoteTextChars);
  return from && text ? { from, text } : null;
}

/**
 * Validates and bounds a notice. Returns null for anything that is not a current-version
 * notice, so a malformed or future payload falls back to the plain message.
 */
export function parseSamNotice(value: unknown): SamNotice | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  if (record.v !== SAM_NOTICE_VERSION) return null;
  const type = clampText(record.type, SAM_NOTICE_LIMITS.typeChars);
  const headline = clampText(record.headline, SAM_NOTICE_LIMITS.headlineChars);
  if (!type || !headline) return null;
  const refs = Array.isArray(record.refs)
    ? record.refs
        .map(normalizeRef)
        .filter((ref): ref is SamNoticeRef => ref !== null)
        .slice(0, SAM_NOTICE_LIMITS.refs)
    : [];
  return {
    v: SAM_NOTICE_VERSION,
    type,
    headline,
    detail: clampText(record.detail, SAM_NOTICE_LIMITS.detailChars),
    severity: isSeverity(record.severity) ? record.severity : 'info',
    refs,
    quote: normalizeQuote(record.quote),
  };
}

/** Builds a bounded notice. Throws only on a missing type or headline (a programming error). */
export function buildSamNotice(input: Omit<SamNotice, 'v'>): SamNotice {
  const notice = parseSamNotice({ ...input, v: SAM_NOTICE_VERSION });
  if (!notice) throw new Error('SAM notice requires a type and a headline');
  return notice;
}
