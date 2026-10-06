import type { DisplayItem } from './tool-call-groups';

/**
 * Resolve the id of the loaded display item nearest to (at or just before) a
 * timestamp. Used to anchor timeline entries that have no exact message id
 * (status updates, activity events) to a row in the list.
 *
 * Takes the DISPLAY array (tool-call groups already folded), so the returned id
 * always resolves through `itemIndexById` to a row that exists.
 */
export function nearestItemId(
  items: readonly DisplayItem[],
  timestamp: number
): string | undefined {
  if (items.length === 0) return undefined;
  let candidateId = items[0]?.id;
  for (const item of items) {
    const ts = 'timestamp' in item && typeof item.timestamp === 'number' ? item.timestamp : 0;
    if (ts <= timestamp) candidateId = item.id;
    else break;
  }
  return candidateId;
}
