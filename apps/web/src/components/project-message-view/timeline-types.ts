export type TimelineEntry =
  | {
      kind: 'user_message';
      id: string;
      messageId: string;
      text: string;
      timestamp: number;
      messageIndex: number;
    }
  | {
      kind: 'system_event';
      id: string;
      eventType: string;
      title: string;
      timestamp: number;
      severity: 'info' | 'success' | 'warning' | 'error';
    };
