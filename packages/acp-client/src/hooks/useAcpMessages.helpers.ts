import { expectJsonRecord } from '../runtime-validation';
import type { ConversationItem, ToolCallContentItem } from './useAcpMessages.types';

/**
 * Maximum number of conversation items retained. When exceeded, the oldest
 * items are pruned. This prevents unbounded memory growth during long agent
 * sessions that generate thousands of tool calls, messages, and thinking
 * blocks.
 */
export const MAX_CONVERSATION_ITEMS = 500;

/**
 * Maximum text length for a single agent message or thinking block.
 * Extremely long streaming responses are truncated to prevent a single item
 * from consuming excessive memory.
 */
export const MAX_ITEM_TEXT_LENGTH = 512_000;

let itemCounter = 0;

export function nextConversationItemId(): string {
  return `item-${++itemCounter}-${Date.now()}`;
}

export function enforceItemCap(items: ConversationItem[]): ConversationItem[] {
  if (items.length <= MAX_CONVERSATION_ITEMS) return items;
  return items.slice(items.length - MAX_CONVERSATION_ITEMS);
}

export function updateLastItem(
  prev: ConversationItem[],
  predicate: (item: ConversationItem) => boolean,
  updater: (item: ConversationItem) => ConversationItem,
  fallback: () => ConversationItem,
): ConversationItem[] {
  const last = prev.at(-1);
  if (last && predicate(last)) {
    const result = prev.slice(0);
    result[result.length - 1] = updater(last);
    return result;
  }
  return enforceItemCap([...prev, fallback()]);
}

export function finalizeStreamingItems(prev: ConversationItem[]): ConversationItem[] {
  let changed = false;
  const result = prev.map((item) => {
    if (item.kind === 'agent_message' && item.streaming) {
      changed = true;
      return { ...item, streaming: false };
    }
    if (item.kind === 'thinking' && item.active) {
      changed = true;
      return { ...item, active: false };
    }
    return item;
  });
  return changed ? result : prev;
}

export function mapToolCallContent(c: { type: string } & Record<string, unknown>): ToolCallContentItem {
  const text = extractToolCallText(c);

  switch (c.type) {
    case 'diff':
      return { type: 'diff', text, data: c };
    case 'terminal':
      return { type: 'terminal', text, data: c };
    case 'content':
    default:
      return { type: 'content', text, data: c };
  }
}

function extractToolCallText(value: unknown, depth = 0): string {
  if (depth > 5 || value === null || value === undefined) {
    return '';
  }

  if (typeof value === 'string') {
    return value;
  }

  if (typeof value === 'number' || typeof value === 'boolean') {
    return String(value);
  }

  if (Array.isArray(value)) {
    return value
      .map((entry) => extractToolCallText(entry, depth + 1))
      .map((entry) => entry.trim())
      .filter(Boolean)
      .join('\n');
  }

  if (typeof value !== 'object') {
    return '';
  }

  const record = expectJsonRecord(value, 'acp.tool_call_content');
  const preferredKeys = ['text', 'output', 'diff', 'content', 'stdout', 'stderr', 'message', 'result'];
  for (const key of preferredKeys) {
    const parsed = extractToolCallText(record[key], depth + 1).trim();
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return '';
}
