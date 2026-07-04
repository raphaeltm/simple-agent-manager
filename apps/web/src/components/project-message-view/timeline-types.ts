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
    };

/** Where a timeline entry should jump to in the message list. */
export interface TimelineJumpTarget {
  /** Exact message anchor, when the entry corresponds to a persisted message. */
  messageId?: string;
  /** Timestamp used to resolve the nearest message when there is no exact anchor. */
  timestamp: number;
}
