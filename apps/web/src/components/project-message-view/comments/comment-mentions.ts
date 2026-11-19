/**
 * @mentions of project members in session comments.
 *
 * A mention is structured: the composer records the member the author picked from the
 * palette, and the body only carries the visible `@Display Name` text. The server keeps the
 * picked IDs that belong to active members and snapshots their display names; plain `@text`
 * that was never picked stays text. These helpers are the single definition of "is this
 * mention's text present", shared by the composer (what to send) and the thread (what to
 * highlight), so the two can never disagree.
 *
 * Pure: no React, no fetching.
 */

import type { CommentMention } from '@simple-agent-manager/shared';

import type { ProjectMemberSummary } from '../../../hooks/useProjectMembers';

/** A member the palette can offer. `label` is exactly the text inserted after the `@`. */
export interface MentionCandidate {
  userId: string;
  label: string;
  email: string | null;
  avatarUrl: string | null;
}

/** A character that continues a name, so `@Ada` inside `@Adam` is not a mention of Ada. */
const NAME_CONTINUATION = /[\p{L}\p{M}\p{N}_]/u;
/** Characters a mention may follow besides whitespace, e.g. `(@Ada)` or `"@Ada"`. */
const MENTION_OPENERS = new Set(['(', '[', '{', '"', "'", '“', '‘']);

/**
 * The visible name for a member, matching the server's snapshot rule
 * (`mentionLabel` in `apps/api/src/services/comment-mentions.ts`): display name, else the
 * email's local part. Null when there is nothing to show — such a member cannot be mentioned
 * by text.
 */
export function memberMentionLabel(
  member: Pick<ProjectMemberSummary, 'name' | 'email'>
): string | null {
  return member.name?.trim() || member.email?.split('@')[0]?.trim() || null;
}

/** Active members with a label, alphabetical. Inactive members never reach the palette. */
export function toMentionCandidates(members: readonly ProjectMemberSummary[]): MentionCandidate[] {
  return members
    .flatMap((member): MentionCandidate[] => {
      if (member.status !== 'active') return [];
      const label = memberMentionLabel(member);
      if (!label) return [];
      return [{ userId: member.userId, label, email: member.email, avatarUrl: member.avatarUrl }];
    })
    .sort((a, b) => a.label.localeCompare(b.label));
}

/**
 * Members whose name, any word of their name, or email local part starts with `filter`
 * (case-insensitive). Whole-name prefix matches rank first, then word matches, then email.
 */
export function filterMentionCandidates(
  candidates: readonly MentionCandidate[],
  filter: string
): MentionCandidate[] {
  const query = filter.trim().toLowerCase();
  if (!query) return [...candidates];

  const ranked: Array<{ candidate: MentionCandidate; rank: number }> = [];
  for (const candidate of candidates) {
    const label = candidate.label.toLowerCase();
    const emailLocal = candidate.email?.split('@')[0]?.toLowerCase() ?? '';
    let rank = -1;
    if (label.startsWith(query)) rank = 0;
    else if (label.split(/\s+/).some((word) => word.startsWith(query))) rank = 1;
    else if (emailLocal.startsWith(query)) rank = 2;
    if (rank >= 0) ranked.push({ candidate, rank });
  }
  // Array.prototype.sort is stable, so alphabetical order survives within a rank.
  return ranked.sort((a, b) => a.rank - b.rank).map((entry) => entry.candidate);
}

export interface MentionSpan {
  /** Index of the `@`. */
  start: number;
  /** Index just past the name. */
  end: number;
  label: string;
}

/**
 * Every `@label` occurrence in `text` that stands on its own: it follows the start of the
 * text, whitespace or an opening bracket/quote, and the name is not followed by more name
 * characters. When labels overlap (`@Ada` and `@Ada Lovelace`) the longest wins.
 */
export function findMentionSpans(text: string, labels: readonly string[]): MentionSpan[] {
  const candidates = [...new Set(labels.filter((label) => label.length > 0))].sort(
    (a, b) => b.length - a.length
  );
  if (candidates.length === 0) return [];

  const spans: MentionSpan[] = [];
  let from = 0;
  while (from < text.length) {
    const at = text.indexOf('@', from);
    if (at === -1) break;
    const previous = at > 0 ? text.charAt(at - 1) : '';
    const standsAlone = at === 0 || /\s/.test(previous) || MENTION_OPENERS.has(previous);
    const label = standsAlone
      ? candidates.find((candidate) => {
          if (!text.startsWith(candidate, at + 1)) return false;
          const next = text.charAt(at + 1 + candidate.length);
          return next === '' || !NAME_CONTINUATION.test(next);
        })
      : undefined;
    if (label) {
      const end = at + 1 + label.length;
      spans.push({ start: at, end, label });
      from = end;
    } else {
      from = at + 1;
    }
  }
  return spans;
}

/**
 * The picked mentions whose `@label` text is still in `body`, de-duplicated by member. A pick
 * whose text the author deleted or edited is dropped, so it does not notify anyone.
 */
export function retainedMentions(
  body: string,
  picked: readonly CommentMention[]
): CommentMention[] {
  const present = new Set(
    findMentionSpans(
      body,
      picked.flatMap((mention) => (mention.displayName ? [mention.displayName] : []))
    ).map((span) => span.label)
  );
  const seen = new Set<string>();
  return picked.filter((mention) => {
    if (!mention.displayName || !present.has(mention.displayName)) return false;
    if (seen.has(mention.userId)) return false;
    seen.add(mention.userId);
    return true;
  });
}

export type MentionSegment = { kind: 'text'; text: string } | { kind: 'mention'; text: string };

/** `text` split into plain runs and `@Name` runs for the given mentions, for rendering. */
export function splitMentionSegments(
  text: string,
  mentions: readonly CommentMention[] | undefined
): MentionSegment[] {
  const labels = (mentions ?? []).flatMap((mention) =>
    mention.displayName ? [mention.displayName] : []
  );
  const spans = findMentionSpans(text, labels);
  if (spans.length === 0) return [{ kind: 'text', text }];

  const segments: MentionSegment[] = [];
  let cursor = 0;
  for (const span of spans) {
    if (span.start > cursor) segments.push({ kind: 'text', text: text.slice(cursor, span.start) });
    segments.push({ kind: 'mention', text: text.slice(span.start, span.end) });
    cursor = span.end;
  }
  if (cursor < text.length) segments.push({ kind: 'text', text: text.slice(cursor) });
  return segments;
}
