import type { CommentInboxBucket } from './comments/comment-inbox';

export type TimelineEntry =
  | {
      kind: 'user_message';
      id: string;
      messageId: string;
      text: string;
      timestamp: number;
    }
  | {
      kind: 'system_event';
      id: string;
      eventType: string;
      title: string;
      timestamp: number;
      severity: 'info' | 'success' | 'warning' | 'error';
    }
  | {
      kind: 'progress_notification';
      id: string;
      notificationId: string;
      title: string;
      text: string;
      timestamp: number;
      severity: 'info';
    }
  /**
   * A comment thread, placed at its most recent activity rather than at its
   * creation time. A comment is a conversation *about* the conversation, and
   * what a reader scanning the timeline needs is when it last moved — a thread
   * opened yesterday that the agent answered a minute ago belongs next to the
   * minute-old entries, not next to yesterday's.
   */
  | {
      kind: 'comment_thread';
      id: string;
      threadId: string;
      /** Anchor message, so this jumps exactly like a `user_message` entry. */
      messageId: string;
      quote: string | null;
      /** Root comment body, truncated for the row. */
      text: string;
      /** Whoever moved the thread last. */
      actorName: string;
      actorKind: 'human' | 'agent';
      /** Renders as "replied" rather than "commented". */
      isReply: boolean;
      status: 'open' | 'sent' | 'resolved';
      /**
       * Triage bucket from the viewer's perspective, from the same
       * `bucketForThread` the inbox and the drawer use.
       *
       * Carried on the entry rather than derived at render time because it needs
       * the viewer's identity, which the drawer does not have. Keying the dot to
       * raw `status` instead looked equivalent and was not: a thread the viewer
       * replied to last is `status: 'open'` but belongs in the neutral `open`
       * bucket, so the timeline painted it amber while the drawer painted the
       * very same thread grey.
       */
      bucket: CommentInboxBucket;
      replyCount: number;
      timestamp: number;
    };

/** Where a timeline entry should jump to in the message list. */
export interface TimelineJumpTarget {
  /** Exact message anchor, when the entry corresponds to a persisted message. */
  messageId?: string;
  /** Timestamp used to resolve the nearest message when there is no exact anchor. */
  timestamp: number;
}
