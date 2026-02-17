import { useState, useCallback, useRef } from 'react';
import type { AcpMessage } from './useAcpSession';
import type { SlashCommand } from '../types';

// =============================================================================
// Conversation Item Types
// =============================================================================

export interface UserMessage {
  kind: 'user_message';
  id: string;
  text: string;
  timestamp: number;
}

export interface AgentMessage {
  kind: 'agent_message';
  id: string;
  text: string;
  streaming: boolean;
  timestamp: number;
}

export interface ThinkingItem {
  kind: 'thinking';
  id: string;
  text: string;
  active: boolean;
  timestamp: number;
}

export interface ToolCallItem {
  kind: 'tool_call';
  id: string;
  toolCallId: string;
  title: string;
  toolKind?: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  content: ToolCallContentItem[];
  locations: Array<{ path: string; line?: number | null }>;
  timestamp: number;
}

export interface ToolCallContentItem {
  type: 'content' | 'diff' | 'terminal';
  text?: string;
  data?: unknown;
}

export interface PlanItem {
  kind: 'plan';
  id: string;
  entries: Array<{
    content: string;
    priority: 'high' | 'medium' | 'low';
    status: 'pending' | 'in_progress' | 'completed';
  }>;
  timestamp: number;
}

export interface RawFallback {
  kind: 'raw_fallback';
  id: string;
  data: unknown;
  timestamp: number;
}

export type ConversationItem =
  | UserMessage
  | AgentMessage
  | ThinkingItem
  | ToolCallItem
  | PlanItem
  | RawFallback;

// =============================================================================
// Usage tracking
// =============================================================================

export interface TokenUsage {
  inputTokens: number;
  outputTokens: number;
  totalTokens: number;
}

// =============================================================================
// Hook return type
// =============================================================================

export interface AcpMessagesHandle {
  items: ConversationItem[];
  usage: TokenUsage;
  availableCommands: SlashCommand[];
  processMessage: (msg: AcpMessage) => void;
  addUserMessage: (text: string) => void;
  clear: () => void;
  /**
   * Synchronously clear all items, finalize any streaming state, and reset
   * usage. Called by the session hook BEFORE replay messages arrive — this
   * avoids the race where useEffect-based clear runs after replay messages
   * have already been appended.
   */
  prepareForReplay: () => void;
}

// =============================================================================
// Hook implementation
// =============================================================================

/**
 * Maximum number of conversation items retained. When exceeded, the oldest
 * items are pruned. This prevents unbounded memory growth during long agent
 * sessions that generate thousands of tool calls, messages, and thinking
 * blocks — the primary cause of Chrome tab crashes.
 */
const MAX_CONVERSATION_ITEMS = 500;

/**
 * Maximum text length for a single agent message or thinking block.
 * Extremely long streaming responses (e.g., dumping a large file) are
 * truncated to prevent a single item from consuming excessive memory.
 */
const MAX_ITEM_TEXT_LENGTH = 512_000; // 512 KB

let itemCounter = 0;
function nextId(): string {
  return `item-${++itemCounter}-${Date.now()}`;
}

/**
 * Enforce the item cap on an array. Drops oldest items when the cap is exceeded.
 * Returns the same array reference if no pruning is needed.
 */
function enforceItemCap(items: ConversationItem[]): ConversationItem[] {
  if (items.length <= MAX_CONVERSATION_ITEMS) return items;
  return items.slice(items.length - MAX_CONVERSATION_ITEMS);
}

/**
 * Update the last item in the array efficiently. When the last item matches
 * the predicate, returns a new array with only the last element replaced —
 * reuses the prefix via slice instead of spreading every element.
 */
function updateLastItem(
  prev: ConversationItem[],
  predicate: (item: ConversationItem) => boolean,
  updater: (item: ConversationItem) => ConversationItem,
  fallback: () => ConversationItem,
): ConversationItem[] {
  const last = prev[prev.length - 1];
  if (last && predicate(last)) {
    const result = prev.slice(0);
    result[result.length - 1] = updater(last);
    return result;
  }
  return enforceItemCap([...prev, fallback()]);
}

/**
 * Finalize any active streaming items (agent_message.streaming → false,
 * thinking.active → false). Only creates new objects for items that
 * actually need updating — skips the rest.
 */
function finalizeStreamingItems(prev: ConversationItem[]): ConversationItem[] {
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

/**
 * Hook that processes ACP session update messages into a structured conversation.
 * Maps SessionNotification.Update variants to ConversationItem types.
 *
 * Memory safety:
 * - Items are capped at MAX_CONVERSATION_ITEMS (oldest pruned)
 * - Individual message text is capped at MAX_ITEM_TEXT_LENGTH
 * - Streaming chunk updates reuse the array prefix to avoid O(n) copies
 * - Tool call updates target only the matching item by index
 *
 * No client-side persistence — on reconnect, the ACP agent replays the full
 * conversation via LoadSession, which sends session/update notifications
 * through the WebSocket. Call `clear()` before reconnection to avoid duplicates.
 */
export function useAcpMessages(): AcpMessagesHandle {
  const [items, setItems] = useState<ConversationItem[]>([]);
  const [usage, setUsage] = useState<TokenUsage>({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const [availableCommands, setAvailableCommands] = useState<SlashCommand[]>([]);

  // Track the last tool call index for efficient tool_call_update lookups.
  // Most updates target the most recently added tool call, so searching
  // backward from here avoids scanning the entire array.
  const lastToolCallIndexRef = useRef(-1);

  const processMessage = useCallback((msg: AcpMessage) => {
    // Handle session notifications (method === 'session/update')
    if (msg.method === 'session/update' && msg.params) {
      const params = msg.params as { update?: { sessionUpdate?: string } & Record<string, unknown> };
      const update = params.update;
      if (!update?.sessionUpdate) return;

      const now = Date.now();

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const content = update as { content?: { type: string; text?: string } };
          const text = content.content?.type === 'text' ? (content.content.text ?? '') : '';
          setItems((prev) =>
            updateLastItem(
              prev,
              (item) => item.kind === 'agent_message' && (item as AgentMessage).streaming,
              (item) => {
                const am = item as AgentMessage;
                const newText = am.text.length + text.length > MAX_ITEM_TEXT_LENGTH
                  ? am.text // Silently stop appending when cap reached
                  : am.text + text;
                return { ...am, text: newText };
              },
              () => ({ kind: 'agent_message' as const, id: nextId(), text, streaming: true, timestamp: now }),
            ),
          );
          break;
        }

        case 'agent_thought_chunk': {
          const content = update as { content?: { type: string; text?: string } };
          const text = content.content?.type === 'text' ? (content.content.text ?? '') : '';
          setItems((prev) =>
            updateLastItem(
              prev,
              (item) => item.kind === 'thinking' && (item as ThinkingItem).active,
              (item) => {
                const ti = item as ThinkingItem;
                const newText = ti.text.length + text.length > MAX_ITEM_TEXT_LENGTH
                  ? ti.text
                  : ti.text + text;
                return { ...ti, text: newText };
              },
              () => ({ kind: 'thinking' as const, id: nextId(), text, active: true, timestamp: now }),
            ),
          );
          break;
        }

        case 'user_message_chunk': {
          // Replayed user messages from LoadSession — render as regular user bubbles
          const content = update as { content?: { type: string; text?: string } };
          const text = content.content?.type === 'text' ? (content.content.text ?? '') : '';
          if (text) {
            setItems((prev) =>
              enforceItemCap([...prev, { kind: 'user_message', id: nextId(), text, timestamp: now }]),
            );
          }
          break;
        }

        case 'tool_call': {
          const tc = update as {
            toolCallId?: string;
            title?: string;
            kind?: string;
            status?: string;
            content?: Array<{ type: string } & Record<string, unknown>>;
            locations?: Array<{ path: string; line?: number | null }>;
          };
          // Finalize any streaming agent message or thinking block
          setItems((prev) => {
            const finalized = finalizeStreamingItems(prev);
            const newItem: ToolCallItem = {
              kind: 'tool_call',
              id: nextId(),
              toolCallId: tc.toolCallId ?? '',
              title: tc.title ?? 'Tool Call',
              toolKind: tc.kind,
              status: (tc.status as ToolCallItem['status']) ?? 'in_progress',
              content: (tc.content ?? []).map(mapToolCallContent),
              locations: tc.locations ?? [],
              timestamp: now,
            };
            const result = enforceItemCap([...finalized, newItem]);
            lastToolCallIndexRef.current = result.length - 1;
            return result;
          });
          break;
        }

        case 'tool_call_update': {
          const tcu = update as {
            toolCallId?: string;
            status?: string;
            content?: Array<{ type: string } & Record<string, unknown>> | null;
            title?: string | null;
          };
          setItems((prev) => {
            // Search backward from the last known tool call index for efficiency.
            // Most tool_call_updates target the most recent tool call.
            let targetIdx = -1;
            const startIdx = Math.min(lastToolCallIndexRef.current, prev.length - 1);
            for (let i = startIdx; i >= 0; i--) {
              const item = prev[i]!;
              if (item.kind === 'tool_call' && item.toolCallId === tcu.toolCallId) {
                targetIdx = i;
                break;
              }
            }
            // Fallback: search forward from startIdx+1 in case of pruning
            if (targetIdx < 0) {
              for (let i = startIdx + 1; i < prev.length; i++) {
                const item = prev[i]!;
                if (item.kind === 'tool_call' && item.toolCallId === tcu.toolCallId) {
                  targetIdx = i;
                  break;
                }
              }
            }
            if (targetIdx < 0) return prev; // Not found — skip

            const target = prev[targetIdx] as ToolCallItem;
            const updated: ToolCallItem = {
              ...target,
              status: (tcu.status as ToolCallItem['status']) ?? target.status,
              title: tcu.title ?? target.title,
              content: tcu.content ? tcu.content.map(mapToolCallContent) : target.content,
            };
            const result = prev.slice(0);
            result[targetIdx] = updated;
            return result;
          });
          break;
        }

        case 'plan': {
          const plan = update as { entries?: Array<{ content: string; priority: string; status: string }> };
          setItems((prev) => {
            const existing = prev.findIndex((i) => i.kind === 'plan');
            const planItem: PlanItem = {
              kind: 'plan',
              id: existing >= 0 ? (prev[existing]?.id ?? nextId()) : nextId(),
              entries: (plan.entries ?? []).map((e) => ({
                content: e.content,
                priority: e.priority as PlanItem['entries'][number]['priority'],
                status: e.status as PlanItem['entries'][number]['status'],
              })),
              timestamp: now,
            };
            if (existing >= 0) {
              const result = prev.slice(0);
              result[existing] = planItem;
              return result;
            }
            return enforceItemCap([...prev, planItem]);
          });
          break;
        }

        case 'available_commands_update': {
          const commandUpdate = update as {
            availableCommands?: Array<{ name: string; description?: string; input?: unknown }>;
          };
          if (commandUpdate.availableCommands) {
            setAvailableCommands(
              commandUpdate.availableCommands.map((cmd) => ({
                name: cmd.name,
                description: cmd.description || '',
                source: 'agent' as const,
              }))
            );
          }
          break;
        }

        case 'usage_update': {
          // Acknowledged ACP notification — context window stats (not rendered in chat)
          break;
        }

        default: {
          // Unknown/unsupported update type — render as raw fallback
          setItems((prev) =>
            enforceItemCap([...prev, { kind: 'raw_fallback', id: nextId(), data: update, timestamp: now }]),
          );
          break;
        }
      }
      return;
    }

    // Handle prompt responses (result with stopReason)
    if (msg.result && typeof msg.result === 'object') {
      const result = msg.result as { stopReason?: string; usage?: TokenUsage };
      if (result.stopReason) {
        // Finalize any streaming items
        setItems(finalizeStreamingItems);
        // Update token usage
        if (result.usage) {
          setUsage((prev) => ({
            inputTokens: prev.inputTokens + (result.usage!.inputTokens ?? 0),
            outputTokens: prev.outputTokens + (result.usage!.outputTokens ?? 0),
            totalTokens: prev.totalTokens + (result.usage!.totalTokens ?? 0),
          }));
        }
      }
    }
  }, []);

  const addUserMessage = useCallback((text: string) => {
    setItems((prev) => enforceItemCap([...prev, {
      kind: 'user_message',
      id: nextId(),
      text,
      timestamp: Date.now(),
    }]));
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    setUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    lastToolCallIndexRef.current = -1;
  }, []);

  const prepareForReplay = useCallback(() => {
    setItems([]);
    setUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    setAvailableCommands([]);
    lastToolCallIndexRef.current = -1;
  }, []);

  return { items, usage, availableCommands, processMessage, addUserMessage, clear, prepareForReplay };
}

// =============================================================================
// Helpers
// =============================================================================

function mapToolCallContent(c: { type: string } & Record<string, unknown>): ToolCallContentItem {
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

  const record = value as Record<string, unknown>;
  const preferredKeys = ['text', 'output', 'diff', 'content', 'stdout', 'stderr', 'message', 'result'];
  for (const key of preferredKeys) {
    const parsed = extractToolCallText(record[key], depth + 1).trim();
    if (parsed.length > 0) {
      return parsed;
    }
  }

  return '';
}
