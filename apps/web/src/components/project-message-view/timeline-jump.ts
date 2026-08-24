import type { ConversationItem } from '@simple-agent-manager/acp-client';

/**
 * Resolve the id of the loaded conversation item nearest to (at or just before)
 * a timestamp. Used to anchor timeline entries that have no exact message id
 * (status updates, activity events) to a message in the list.
 */
export function nearestItemId(items: ConversationItem[], timestamp: number): string | undefined {
  if (items.length === 0) return undefined;
  let candidateId = items[0]?.id;
  for (const item of items) {
    const ts = 'timestamp' in item && typeof item.timestamp === 'number' ? item.timestamp : 0;
    if (ts <= timestamp) candidateId = item.id;
    else break;
  }
  return candidateId;
}
