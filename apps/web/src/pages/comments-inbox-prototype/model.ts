/**
 * Pure helpers for the comments inbox prototype: which bucket an item is in, the
 * notification-style "why is this here" line, and the excerpt of the commented text.
 */
import { type CommentEntry, type InboxItem, ME } from './mock-data';

/**
 * Three plain buckets. "Needs you": someone else (a teammate or the agent) spoke last.
 * "Waiting": you spoke last, whether you sent it to the agent, replied, or left a note.
 */
export type Bucket = 'needs_you' | 'waiting' | 'resolved';
export type Filter = Bucket;

export const FILTERS: { value: Filter; label: string }[] = [
  { value: 'needs_you', label: 'Needs you' },
  { value: 'waiting', label: 'Waiting' },
  { value: 'resolved', label: 'Resolved' },
];

export function lastEntry(item: InboxItem): CommentEntry {
  return item.entries[item.entries.length - 1] as CommentEntry;
}

export function lastActivityAt(item: InboxItem): number {
  return lastEntry(item).at;
}

/** Someone else spoke last → it needs you. You spoke last → waiting on them or the agent. */
export function bucketFor(item: InboxItem): Bucket {
  if (item.status === 'resolved') return 'resolved';
  return lastEntry(item).author.id === ME.id ? 'waiting' : 'needs_you';
}

export function matchesFilter(item: InboxItem, filter: Filter): boolean {
  return bucketFor(item) === filter;
}

export function countFor(items: InboxItem[], filter: Filter): number {
  return items.filter((item) => matchesFilter(item, filter)).length;
}

export function sortByActivity(items: InboxItem[]): InboxItem[] {
  return [...items].sort((a, b) => lastActivityAt(b) - lastActivityAt(a));
}

function firstName(name: string): string {
  return name.split(/\s+/)[0] ?? name;
}

/** The notification-style line: who did what, from the viewer's point of view. */
export function reasonFor(item: InboxItem): { actor: string; verb: string } {
  const last = lastEntry(item);
  const isReply = item.entries.length > 1;
  const viewerStarted = item.entries[0]?.author.id === ME.id;
  const where =
    item.source.kind === 'file'
      ? 'a file'
      : item.source.youControl && item.source.ownerName === 'You'
        ? 'your chat'
        : `${firstName(item.source.ownerName)}'s chat`;

  if (item.status === 'resolved') return { actor: 'Resolved', verb: '' };
  if (last.author.id === ME.id) {
    if (item.status === 'sent') return { actor: 'You', verb: 'sent this to the agent' };
    return { actor: 'You', verb: isReply ? 'replied' : 'left a note' };
  }
  if (last.author.kind === 'agent') {
    return { actor: 'The agent', verb: viewerStarted ? 'replied to your comment' : 'replied' };
  }
  if (last.mentionsMe) return { actor: last.author.name, verb: 'mentioned you' };
  if (isReply) return { actor: last.author.name, verb: 'replied' };
  return { actor: last.author.name, verb: `commented on ${where}` };
}

export function relative(at: number, now = Date.now()): string {
  const minutes = Math.max(0, Math.floor((now - at) / 60_000));
  if (minutes < 1) return 'now';
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h`;
  return `${Math.floor(hours / 24)}d`;
}

export interface Excerpt {
  leadingEllipsis: boolean;
  before: string;
  quote: string;
  after: string;
  trailingEllipsis: boolean;
}

/** Cut at a word boundary so an excerpt never starts or ends mid-word. */
function snapStart(text: string, index: number): number {
  if (index <= 0) return 0;
  const space = text.indexOf(' ', index);
  return space === -1 ? index : space + 1;
}

function snapEnd(text: string, index: number): number {
  if (index >= text.length) return text.length;
  const space = text.lastIndexOf(' ', index);
  return space <= 0 ? index : space;
}

/**
 * The commented text around the quote, so the reader sees the quote in its sentence without
 * opening the chat. With no quote, the start of the message.
 */
export function excerptFor(
  text: string,
  quote: string | null,
  { before, after }: { before: number; after: number }
): Excerpt {
  // An excerpt is a preview: drop markdown markers rather than show them raw.
  const flat = text
    .replace(/`|\*\*/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  const index = quote ? flat.indexOf(quote) : -1;
  if (!quote || index === -1) {
    const end = snapEnd(flat, before + after);
    return {
      leadingEllipsis: false,
      before: flat.slice(0, end),
      quote: '',
      after: '',
      trailingEllipsis: end < flat.length,
    };
  }
  const start = snapStart(flat, index - before);
  const quoteEnd = index + quote.length;
  const end = snapEnd(flat, quoteEnd + after);
  return {
    leadingEllipsis: start > 0,
    before: flat.slice(start, index),
    quote,
    after: flat.slice(quoteEnd, Math.max(end, quoteEnd)),
    trailingEllipsis: Math.max(end, quoteEnd) < flat.length,
  };
}

/** "The agent's reply", "Prakash's message", or the file name: what the excerpt is from. */
export function sourceLabel(item: InboxItem): string {
  if (item.source.kind === 'file') return item.source.fileName;
  const { message, ownerName } = item.source;
  if (message.by === 'agent') return "The agent's reply";
  if (message.by === 'owner')
    return ownerName === 'You' ? 'Your message' : `${ownerName}'s message`;
  return `${message.byName ?? 'A teammate'}'s message`;
}
