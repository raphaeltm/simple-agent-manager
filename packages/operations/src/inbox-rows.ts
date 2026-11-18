/**
 * Maps one inbox row (from `inbox-list-core.ts` or a single-item read) to an `InboxItem`.
 * Every row is validated, because it crosses a storage boundary (rule 51); a row that fails
 * throws here and the list skips it (rule 50).
 */
import {
  ASK_KINDS,
  ASK_STATUSES,
  type AskStatus,
  formatInboxRef,
  INBOX_ERROR_ACTIONS,
  type InboxAgentState,
  type InboxAnswerSpec,
  type InboxItem,
  type InboxItemKind,
  type InboxLink,
  type ParsedInboxRef,
} from '@simple-agent-manager/shared';
import * as v from 'valibot';

const int = v.pipe(v.number(), v.safeInteger());
const nullableText = v.nullable(v.string());

export const InboxRowSchema = v.object({
  store: v.picklist(['ask', 'attention', 'secret', 'approval']),
  item_id: v.pipe(v.string(), v.minLength(1)),
  marker_id: v.nullable(v.union([v.string(), v.number()])),
  project_id: v.string(),
  session_id: nullableText,
  task_id: nullableText,
  kind: nullableText,
  blocking: v.union([v.literal(0), v.literal(1)]),
  title: nullableText,
  body: nullableText,
  status: v.picklist(ASK_STATUSES),
  created_at: int,
  expires_at: v.nullable(int),
  due_at: v.nullable(int),
  extra_json: nullableText,
  links_json: nullableText,
  can_act: v.union([v.literal(0), v.literal(1)]),
  stack_key: v.string(),
  project_name: v.optional(nullableText, null),
  topic: v.optional(nullableText, null),
  task_status: v.optional(nullableText, null),
  task_step: v.optional(nullableText, null),
  // `asks` rows only (other stores select NULL).
  updated_at: v.optional(v.nullable(int), null),
  failure_count: v.optional(v.nullable(int), null),
});
export type InboxRow = v.InferOutput<typeof InboxRowSchema>;

/** `session_summaries.attention_json` (`getAttentionSummary`); extra fields are optional on legacy rows. */
const AttentionSummarySchema = v.object({
  markerId: v.pipe(v.string(), v.minLength(1)),
  kind: v.literal('needs_input'),
  createdAt: int,
  expiresAt: v.nullable(int),
  reason: nullableText,
  options: v.optional(v.array(v.string()), []),
  source: v.optional(nullableText, null),
  category: v.optional(nullableText, null),
  interactionId: v.optional(nullableText, null),
  interactionKind: v.optional(nullableText, null),
});

const LinkSchema = v.object({
  kind: v.pipe(v.string(), v.minLength(1), v.maxLength(40)),
  // A URL kind (`pr`, `preview`) keeps its URL here, so allow a URL's length.
  id: v.pipe(v.string(), v.minLength(1), v.maxLength(500)),
  label: v.optional(v.nullable(v.pipe(v.string(), v.maxLength(200))), null),
});
export const InboxLinksSchema = v.array(LinkSchema);

export const AskAnswerSpecSchema = v.variant('type', [
  v.object({
    type: v.literal('options'),
    options: v.pipe(
      v.array(v.pipe(v.string(), v.minLength(1), v.maxLength(200))),
      v.minLength(1),
      v.maxLength(20)
    ),
    allowText: v.optional(v.boolean(), false),
  }),
  v.object({ type: v.literal('text') }),
  v.object({ type: v.literal('acknowledge') }),
  // System error items (slice E): fixes SAM can run, first is primary.
  v.object({
    type: v.literal('actions'),
    actions: v.pipe(
      v.array(
        v.object({
          id: v.picklist(INBOX_ERROR_ACTIONS),
          label: v.pipe(v.string(), v.minLength(1), v.maxLength(60)),
        })
      ),
      v.minLength(1),
      v.maxLength(INBOX_ERROR_ACTIONS.length)
    ),
  }),
]);

const ApprovalExtraSchema = v.object({ targetType: v.string(), targetId: v.string() });

/** Task statuses after which the filing agent can no longer be woken. */
export const TERMINAL_TASK_STATUSES = ['completed', 'failed', 'cancelled'] as const;
const TERMINAL_TASK = new Set<string>(TERMINAL_TASK_STATUSES);
const NOT_STARTED_TASK = new Set(['draft', 'queued']);

export function inboxAgentState(
  row: Pick<InboxRow, 'task_id' | 'task_status' | 'blocking' | 'status'>
): InboxAgentState {
  if (!row.task_id || !row.task_status) return 'unknown';
  if (TERMINAL_TASK.has(row.task_status)) return 'finished';
  if (NOT_STARTED_TASK.has(row.task_status)) return 'not_started';
  if (row.blocking === 1 && row.status === 'open') return 'waiting';
  return 'working';
}

/** One sentence from an agent's free text, for the row title. */
export function inboxTitle(text: string, maxChars: number): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? '';
  const sentence = /^(.+?[.?!])(\s|$)/.exec(firstLine)?.[1] ?? firstLine;
  return sentence.length <= maxChars ? sentence : `${sentence.slice(0, maxChars - 1)}…`;
}

const TITLE_FALLBACK_CHARS = 200;

function iso(ms: number | null): string | null {
  return ms === null ? null : new Date(ms).toISOString();
}

function parseJson(text: string | null, label: string): unknown {
  if (text === null) return null;
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new Error(`${label} is not valid JSON`);
  }
}

export function inboxItemFromRow(row: InboxRow, now: number): InboxItem {
  let ref: ParsedInboxRef;
  let kind: InboxItemKind;
  let title: string;
  let body = row.body;
  let answerSpec: InboxAnswerSpec;
  let links: InboxLink[] = [];
  let createdAt = row.created_at;
  let expiresAt = row.expires_at;

  switch (row.store) {
    case 'ask': {
      if (!(ASK_KINDS as readonly string[]).includes(row.kind ?? ''))
        throw new Error(`unknown ask kind ${String(row.kind)}`);
      kind = row.kind as InboxItemKind;
      ref = { store: 'ask', id: row.item_id };
      title = row.title ?? '';
      const spec = parseJson(row.extra_json, 'answer_spec_json');
      answerSpec = spec
        ? (v.parse(AskAnswerSpecSchema, spec) as InboxAnswerSpec)
        : kind === 'question'
          ? { type: 'text' }
          : { type: 'acknowledge' };
      links = row.links_json
        ? v.parse(InboxLinksSchema, parseJson(row.links_json, 'links_json')).map((link) => ({
            kind: link.kind,
            id: link.id,
            label: link.label ?? null,
          }))
        : [];
      break;
    }
    case 'attention': {
      const summary = v.parse(AttentionSummarySchema, parseJson(row.extra_json, 'attention_json'));
      ref = { store: 'attention', sessionId: row.item_id, markerId: summary.markerId };
      createdAt = summary.createdAt;
      expiresAt = summary.expiresAt;
      const interaction =
        summary.source === 'acp_interaction' || summary.reason === 'acp_interaction_pending';
      if (interaction) {
        const interactionKind =
          summary.interactionKind === 'form' || summary.interactionKind === 'url'
            ? summary.interactionKind
            : 'permission';
        kind = interactionKind;
        title =
          interactionKind === 'form'
            ? 'The agent needs a form filled in'
            : interactionKind === 'url'
              ? 'The agent asks you to open a link'
              : 'The agent asks for permission';
        body = null;
        answerSpec = { type: 'interaction', interactionId: summary.interactionId, interactionKind };
      } else {
        kind = 'question';
        const reason = summary.reason ?? '';
        title = reason ? inboxTitle(reason, TITLE_FALLBACK_CHARS) : 'The agent has a question';
        body = summary.reason;
        answerSpec =
          summary.options.length > 0
            ? { type: 'options', options: summary.options, allowText: false }
            : { type: 'text' };
      }
      break;
    }
    case 'secret':
      kind = 'secret';
      ref = { store: 'secret', id: row.item_id };
      title = `Secret requested: ${row.title ?? ''}`;
      answerSpec = { type: 'secret', envKey: row.title ?? '', requestId: row.item_id };
      break;
    case 'approval': {
      kind = 'approval';
      ref = { store: 'approval', id: row.item_id };
      const target = v.parse(ApprovalExtraSchema, parseJson(row.extra_json, 'approval target'));
      title = `Approve ${row.title ?? 'action'} on ${target.targetType} ${target.targetId}`;
      answerSpec = {
        type: 'approval',
        action: row.title ?? '',
        targetType: target.targetType,
        targetId: target.targetId,
      };
      break;
    }
  }

  const status: AskStatus = row.status;
  return {
    ref: formatInboxRef(ref),
    store: row.store,
    kind,
    projectId: row.project_id,
    projectName: row.project_name ?? null,
    sessionId: row.session_id,
    topic: row.topic ?? null,
    taskId: row.task_id,
    stackKey: row.stack_key,
    title,
    body,
    blocking: row.blocking === 1,
    agentState: inboxAgentState(row),
    status,
    createdAt: new Date(createdAt).toISOString(),
    updatedAt: new Date(Math.max(row.updated_at ?? createdAt, createdAt)).toISOString(),
    failureCount: kind === 'error' ? Math.max(1, row.failure_count ?? 1) : null,
    expiresAt: iso(expiresAt),
    dueAt: iso(row.due_at),
    answerSpec,
    links,
    canAct: row.can_act === 1 && status === 'open' && (expiresAt === null || expiresAt > now),
    untrustedContent: true,
  };
}
