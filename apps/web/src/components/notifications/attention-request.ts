import type { NotificationResponse } from '@simple-agent-manager/shared';

import { maybeJsonRecord } from '../../lib/runtime-validation';

export function attentionRequest(notification: NotificationResponse) {
  const metadata = maybeJsonRecord(notification.metadata);
  const markerId =
    typeof metadata?.attentionMarkerId === 'string' ? metadata.attentionMarkerId : null;
  const options = Array.isArray(metadata?.options)
    ? metadata.options.filter((option): option is string => typeof option === 'string')
    : [];
  return {
    markerId,
    options,
    readable:
      notification.type === 'needs_input' &&
      Boolean(markerId && notification.projectId && notification.sessionId),
  };
}
