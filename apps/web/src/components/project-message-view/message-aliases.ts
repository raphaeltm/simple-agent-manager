/**
 * Which displayed item each stored message row ended up in.
 *
 * The VM agent stores an agent reply as one row per streamed chunk, and
 * `chatMessagesToConversationItems` merges consecutive `assistant` rows (and consecutive
 * `thinking` rows) into one item that keeps the FIRST row's id. Every other row id of that
 * reply appears nowhere in the rendered list. A comment can be anchored to any of them — an
 * MCP-created comment, or one made when a page boundary split the reply so its first loaded
 * chunk was a later one — and an anchor that resolves to nothing is what made "jump to the
 * comment" land in the wrong place.
 *
 * The rule mirrors the merge exactly: a merged chunk joins the item most recently started,
 * because only starting an item changes what the merge appends to. Rows that start an item
 * keep their own id; tool-call updates and plan replacements, which merge by tool-call id or
 * in place rather than into the latest item, are not aliased here (tool calls carry their own
 * `messageId` alias).
 */
import { MERGED_MESSAGE_ROLES } from '@simple-agent-manager/shared';

import type { DisplayItem } from './tool-call-groups';

/** Ids of every rendered item, including the calls and thoughts inside tool-call groups. */
export function renderedItemIds(items: readonly DisplayItem[]): Set<string> {
  const ids = new Set<string>();
  for (const item of items) {
    ids.add(item.id);
    if (item.kind === 'tool_call_group') for (const inner of item.items) ids.add(inner.id);
  }
  return ids;
}

/** Row id → id of the item it was merged into, for every merged chunk row. */
export function mergedRowAliases(
  rows: readonly { id: string; role: string }[],
  items: readonly DisplayItem[]
): Map<string, string> {
  const itemIds = renderedItemIds(items);
  const aliases = new Map<string, string>();
  let latestItemId: string | null = null;
  for (const row of rows) {
    if (itemIds.has(row.id)) {
      latestItemId = row.id;
    } else if (latestItemId !== null && MERGED_MESSAGE_ROLES.has(row.role)) {
      aliases.set(row.id, latestItemId);
    }
  }
  return aliases;
}
