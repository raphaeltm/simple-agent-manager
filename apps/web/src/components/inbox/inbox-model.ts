import {
  type InboxAnswerSpec,
  type InboxFilter,
  type InboxItem,
  type InboxItemKind,
  type InboxLink,
  OPERATIONS_IRREVERSIBLE_ACTIONS,
  type OperationsAction,
} from '@simple-agent-manager/shared';
import {
  CircleAlert,
  CircleCheckBig,
  Eye,
  FileText,
  GitPullRequest,
  Globe,
  KeyRound,
  Lightbulb,
  Link2,
  ListChecks,
  type LucideIcon,
  MessageCircleQuestion,
  MessageSquare,
  Scale,
  ShieldCheck,
  ShieldQuestion,
} from 'lucide-react';

import {
  projectAgentContextPath,
  projectChatPath,
  projectIdeaPath,
  projectLibraryFilePath,
} from '../../lib/project-routes';
import { formatMsSpan } from '../../lib/time-utils';

/**
 * Pure inbox view model (slice C, spec idea 01M7G03ZCQ6TM6CMEYDRKQ8ST9 section 4.1). Items arrive
 * sorted by the server (live deadlines, then blocking oldest first, then the rest oldest first);
 * this module only groups them into stacks and words them.
 */

/** Chips: the server filters plus Updates (the existing FYI notifications). */
export type InboxView = InboxFilter | 'updates';

export const INBOX_CHIPS: { value: InboxView; label: string }[] = [
  { value: 'needs_you', label: 'Needs you' },
  { value: 'blocking', label: 'Blocking' },
  { value: 'tasks', label: 'Tasks' },
  { value: 'reviews', label: 'Reviews' },
  { value: 'updates', label: 'Updates' },
];

const VIEWS: readonly InboxView[] = [
  'needs_you',
  'blocking',
  'tasks',
  'reviews',
  'updates',
  'archived',
];

export function parseInboxView(value: string | null): InboxView {
  return (VIEWS as readonly string[]).includes(value ?? '') ? (value as InboxView) : 'needs_you';
}

export const KIND_META: Record<InboxItemKind, { label: string; icon: LucideIcon }> = {
  question: { label: 'Question', icon: MessageCircleQuestion },
  permission: { label: 'Permission', icon: ShieldQuestion },
  form: { label: 'Form', icon: ShieldQuestion },
  url: { label: 'Sign-in link', icon: Link2 },
  secret: { label: 'Secret', icon: KeyRound },
  approval: { label: 'Approval', icon: ShieldCheck },
  review: { label: 'Review', icon: Eye },
  result: { label: 'Result', icon: CircleCheckBig },
  task: { label: 'Task', icon: ListChecks },
  error: { label: 'Problem', icon: CircleAlert },
};

/**
 * Whether a row from the server has the fields the inbox renders. One malformed row is skipped
 * (and logged), never allowed to break the list (`.claude/rules/50`).
 */
export function isRenderableInboxItem(value: unknown): value is InboxItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Partial<InboxItem>;
  return (
    typeof item.ref === 'string' &&
    typeof item.projectId === 'string' &&
    typeof item.title === 'string' &&
    typeof item.stackKey === 'string' &&
    typeof item.kind === 'string' &&
    item.kind in KIND_META &&
    typeof item.createdAt === 'string' &&
    Array.isArray(item.links) &&
    !!item.answerSpec &&
    typeof item.answerSpec === 'object' &&
    typeof item.answerSpec.type === 'string'
  );
}

/** The agent is stopped on this item: the one state worth amber. */
export function isPausedOnItem(item: InboxItem): boolean {
  return item.agentState === 'waiting' && item.status === 'open';
}

/** Time left before a live deadline ("4m", "1h 30m"), or null when there is none (or it passed). */
export function timeLeft(item: InboxItem, now: number): string | null {
  if (!item.expiresAt || item.status !== 'open') return null;
  const ms = Date.parse(item.expiresAt) - now;
  return Number.isFinite(ms) && ms > 0 ? formatMsSpan(ms) : null;
}

/** An Operations approval whose action cannot be undone (approving deletes its target). */
export function isIrreversibleApproval(spec: InboxAnswerSpec): boolean {
  return (
    spec.type === 'approval' &&
    OPERATIONS_IRREVERSIBLE_ACTIONS.includes(spec.action as OperationsAction)
  );
}

/** Short agent state for a row ("paused on this"), or null when unknown. */
export function agentStateShort(item: InboxItem): string | null {
  switch (item.agentState) {
    case 'waiting':
      return 'paused on this';
    case 'working':
      return 'still working';
    case 'finished':
      return 'finished';
    case 'not_started':
      return 'never started';
    default:
      return null;
  }
}

/** Long agent state for the item meta line ("Paused, waiting on this"). */
export function agentStateLong(item: InboxItem): string | null {
  switch (item.agentState) {
    case 'waiting':
      return 'Paused, waiting on this';
    case 'working':
      return 'Still working';
    case 'finished':
      return 'Finished';
    case 'not_started':
      return 'Never started';
    default:
      return null;
  }
}

/** Compact age of an item ("12m", "3h 5m", "2d"). */
export function formatAge(iso: string, now: number): string {
  return formatMsSpan(now - Date.parse(iso));
}

/** SAM's actions on an error item (slice E). Unknown action ids are ignored. */
export const INBOX_ERROR_ACTION_IDS = ['retry', 'wake', 'resume', 'open_chat'] as const;
export type InboxErrorActionId = (typeof INBOX_ERROR_ACTION_IDS)[number];
export interface InboxErrorActionModel {
  id: InboxErrorActionId;
  label: string;
}

/**
 * The named actions of an error item (`answerSpec.type === 'actions'`, slice E), read at runtime
 * so a build without slice E's types still renders them. Order is display order; the first is
 * primary. Null when the item has none.
 */
export function readErrorActions(item: InboxItem): InboxErrorActionModel[] | null {
  const spec = item.answerSpec as { type?: unknown; actions?: unknown };
  if (spec.type !== 'actions' || !Array.isArray(spec.actions)) return null;
  const actions = spec.actions.filter(
    (action): action is InboxErrorActionModel =>
      !!action &&
      typeof action === 'object' &&
      (INBOX_ERROR_ACTION_IDS as readonly unknown[]).includes((action as { id?: unknown }).id) &&
      typeof (action as { label?: unknown }).label === 'string'
  );
  return actions.length > 0 ? actions : null;
}

/**
 * Whether an item has an answer area to pin. Open human tasks and SAM's own error items have
 * nothing to answer yet (Open chat is in the top bar), so they show no empty control strip.
 */
export function hasPinnedControls(item: InboxItem): boolean {
  if (item.status !== 'open' || !item.canAct) return true;
  if (readErrorActions(item)) return true;
  return !(item.answerSpec.type === 'acknowledge' && !isAcknowledgeable(item));
}

/** Reviews and results are answered from the inbox: "Looks good" / "Got it", or a reply. */
export function isAcknowledgeable(item: InboxItem): boolean {
  return item.kind === 'review' || item.kind === 'result';
}

/** The one-tap acknowledgement for a review or a result. */
export function acknowledgeLabel(item: InboxItem): string {
  return item.kind === 'result' ? 'Got it' : 'Looks good';
}

/** A list row: one item, or a stack of items from one chat (or one group). */
export type InboxRowModel =
  | { type: 'item'; key: string; item: InboxItem }
  | { type: 'stack'; key: string; items: InboxItem[] };

/** Group into stacks in first-appearance order, keeping the server order inside each stack. */
export function buildRows(items: InboxItem[]): InboxRowModel[] {
  const byKey = new Map<string, InboxItem[]>();
  for (const item of items) {
    const members = byKey.get(item.stackKey);
    if (members) members.push(item);
    else byKey.set(item.stackKey, [item]);
  }
  return [...byKey.entries()].map(([key, members]) =>
    members.length === 1 && members[0]
      ? { type: 'item', key: members[0].ref, item: members[0] }
      : { type: 'stack', key: `stack:${key}`, items: members }
  );
}

/** The walk order behind previous / next: stack members stay together. */
export function walkOrder(items: InboxItem[]): InboxItem[] {
  return buildRows(items).flatMap((row) => (row.type === 'item' ? [row.item] : row.items));
}

/**
 * Where to go after `ref` leaves the walk: the next item after it, or the first remaining one
 * when it was last, or null when nothing remains (the empty state). Answering the last item of a
 * stack therefore lands on the next stack.
 */
export function nextAfter(order: InboxItem[], ref: string): InboxItem | null {
  const index = order.findIndex((item) => item.ref === ref);
  const after = order.slice(index + 1).find((item) => item.ref !== ref);
  if (after) return after;
  return order.find((item) => item.ref !== ref) ?? null;
}

/** "2 of 3 from Ship billing", or null outside a stack. */
export function stackPosition(
  order: InboxItem[],
  item: InboxItem
): { index: number; total: number; topic: string | null } | null {
  const members = order.filter((candidate) => candidate.stackKey === item.stackKey);
  if (members.length < 2) return null;
  return {
    index: members.findIndex((member) => member.ref === item.ref) + 1,
    total: members.length,
    topic: item.topic,
  };
}

/** Context summary: "2 messages before · 3 things done since". */
export function contextSummary(before: number, since: number): string {
  const parts = [`${before} message${before === 1 ? '' : 's'} before`];
  if (since > 0) parts.push(`${since} thing${since === 1 ? '' : 's'} done since`);
  return parts.join(' · ');
}

const LINK_ICONS: Record<string, LucideIcon> = {
  idea: Lightbulb,
  file: FileText,
  library: FileText,
  chat: MessageSquare,
  session: MessageSquare,
  pr: GitPullRequest,
  pull_request: GitPullRequest,
  policy: Scale,
  knowledge: Scale,
  preview: Globe,
  url: Globe,
};

export function linkIcon(link: InboxLink): LucideIcon {
  return LINK_ICONS[link.kind] ?? Link2;
}

/**
 * Where a link chip goes, resolved with the reader's own access (the target page checks it).
 * `external` links open in a new tab; null means the reference has no page (shown as text).
 */
export function linkTarget(
  projectId: string,
  link: InboxLink
): { href: string; external: boolean; host?: string } | null {
  // A dot segment would climb out of the intended path once the router resolves it.
  if (!link.id || link.id === '.' || link.id === '..') return null;
  switch (link.kind) {
    case 'idea':
      return { href: projectIdeaPath(projectId, link.id), external: false };
    case 'file':
    case 'library':
      return { href: projectLibraryFilePath(projectId, link.id), external: false };
    case 'chat':
    case 'session':
      return { href: projectChatPath(projectId, link.id), external: false };
    case 'policy':
    case 'knowledge':
      return { href: projectAgentContextPath(projectId), external: false };
    case 'pr':
    case 'pull_request':
    case 'preview':
    case 'url':
      return externalTarget(link.id);
    default:
      return null;
  }
}

/**
 * An agent-supplied external link: https only, no credentials in the URL, and the host returned
 * so the chip can show where it really goes (the label is the agent's own text).
 */
function externalTarget(id: string): { href: string; external: true; host: string } | null {
  let url: URL;
  try {
    url = new URL(id);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' || url.username || url.password || !url.hostname) return null;
  return { href: url.toString(), external: true, host: url.hostname };
}

/** The label a link chip shows: the agent's label, else the kind and id. */
export function linkLabel(link: InboxLink): string {
  return link.label?.trim() || `${link.kind} ${link.id}`;
}
