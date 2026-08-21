/**
 * Types for the commenting prototype.
 *
 * PROTOTYPE ONLY — mock data, no API. See `.claude/rules/37-prototype-development.md`.
 *
 * The shape here is deliberately close to what a real `comments` table would need,
 * so the prototype doubles as a schema proposal. The load-bearing idea is that a
 * comment is anchored to a *target* by a discriminated union, so the same thread
 * component serves chat messages and markdown files (and later: diffs, tool calls,
 * library files) without a second implementation.
 */

/** Where a comment is attached. The discriminant is what makes one UI serve many surfaces. */
export type CommentAnchor =
  | {
      kind: 'message';
      /** ProjectData `chat_messages.id` in the real system. */
      messageId: string;
      /** Present when the user selected a span rather than commenting on the whole message. */
      quote?: string;
    }
  | {
      kind: 'file';
      /** Repo-relative path, e.g. `docs/architecture/overview.md`. */
      path: string;
      /** Stable id of the rendered markdown block the comment is anchored to. */
      blockId: string;
      /** The selected text. Used to re-anchor if the block moves. */
      quote?: string;
    };

export type CommentAuthorKind = 'human' | 'agent';

export interface CommentAuthor {
  id: string;
  name: string;
  kind: CommentAuthorKind;
  /** Two-letter initials for the avatar chip. */
  initials: string;
}

export interface CommentReply {
  id: string;
  author: CommentAuthor;
  body: string;
  createdAt: number;
}

/**
 * `status` is the MVP's whole workflow model:
 * - `open`     — a note, nobody has acted on it
 * - `sent`     — dispatched to the agent as an instruction; agent is working
 * - `resolved` — closed, collapsed by default
 */
export type CommentStatus = 'open' | 'sent' | 'resolved';

export interface Comment {
  id: string;
  anchor: CommentAnchor;
  author: CommentAuthor;
  body: string;
  createdAt: number;
  status: CommentStatus;
  replies: CommentReply[];
}

/** A chat message in the prototype transcript. Mirrors the real ConversationItem subset we render. */
export interface PrototypeMessage {
  id: string;
  role: 'user' | 'agent';
  text: string;
  timestamp: number;
}

export function commentsForMessage(comments: Comment[], messageId: string): Comment[] {
  return comments.filter((c) => c.anchor.kind === 'message' && c.anchor.messageId === messageId);
}

export function commentsForBlock(comments: Comment[], blockId: string): Comment[] {
  return comments.filter((c) => c.anchor.kind === 'file' && c.anchor.blockId === blockId);
}

/** Relative time formatter — avoids a date library in prototype code. */
export function relativeTime(ts: number, now: number): string {
  const diff = Math.max(0, now - ts);
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return 'just now';
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  return `${days}d ago`;
}
