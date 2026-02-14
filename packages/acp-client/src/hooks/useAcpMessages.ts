import { useState, useCallback, useEffect } from 'react';
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
}

/** Options for the useAcpMessages hook */
export interface UseAcpMessagesOptions {
  /** Session ID used as the key for sessionStorage persistence.
   *  When provided, messages survive WebSocket reconnections (e.g. mobile tab resume). */
  sessionId?: string;
}

// =============================================================================
// Hook implementation
// =============================================================================

let itemCounter = 0;
function nextId(): string {
  return `item-${++itemCounter}-${Date.now()}`;
}

/** sessionStorage key prefix for persisted conversation items */
const STORAGE_KEY_PREFIX = 'acp-messages-';

/** Load persisted conversation items from sessionStorage */
function loadPersistedItems(sessionId: string): ConversationItem[] {
  if (typeof sessionStorage === 'undefined') return [];
  try {
    const stored = sessionStorage.getItem(`${STORAGE_KEY_PREFIX}${sessionId}`);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as ConversationItem[];
    if (!Array.isArray(parsed)) return [];
    // Finalize any items that were streaming when we persisted
    return parsed.map((item) => {
      if (item.kind === 'agent_message' && item.streaming) return { ...item, streaming: false };
      if (item.kind === 'thinking' && item.active) return { ...item, active: false };
      return item;
    });
  } catch {
    return [];
  }
}

/** Persist conversation items to sessionStorage */
function persistItems(sessionId: string, items: ConversationItem[]): void {
  if (typeof sessionStorage === 'undefined') return;
  try {
    sessionStorage.setItem(`${STORAGE_KEY_PREFIX}${sessionId}`, JSON.stringify(items));
  } catch {
    // sessionStorage full or unavailable — silently ignore
  }
}

/**
 * Hook that processes ACP session update messages into a structured conversation.
 * Maps SessionNotification.Update variants to ConversationItem types.
 *
 * When `sessionId` is provided, messages are persisted in sessionStorage so they
 * survive WebSocket reconnections (e.g. mobile background tab resume).
 */
export function useAcpMessages(options?: UseAcpMessagesOptions): AcpMessagesHandle {
  const sessionId = options?.sessionId;
  const [items, setItems] = useState<ConversationItem[]>(() =>
    sessionId ? loadPersistedItems(sessionId) : []
  );
  const [usage, setUsage] = useState<TokenUsage>({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
  const [availableCommands, setAvailableCommands] = useState<SlashCommand[]>([]);

  // Persist items to sessionStorage when they change
  useEffect(() => {
    if (sessionId && items.length > 0) {
      persistItems(sessionId, items);
    }
  }, [sessionId, items]);

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
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === 'agent_message' && last.streaming) {
              return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            }
            return [...prev, { kind: 'agent_message', id: nextId(), text, streaming: true, timestamp: now }];
          });
          break;
        }

        case 'agent_thought_chunk': {
          const content = update as { content?: { type: string; text?: string } };
          const text = content.content?.type === 'text' ? (content.content.text ?? '') : '';
          setItems((prev) => {
            const last = prev[prev.length - 1];
            if (last?.kind === 'thinking' && last.active) {
              return [...prev.slice(0, -1), { ...last, text: last.text + text }];
            }
            return [...prev, { kind: 'thinking', id: nextId(), text, active: true, timestamp: now }];
          });
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
            const finalized = prev.map((item) => {
              if (item.kind === 'agent_message' && item.streaming) return { ...item, streaming: false };
              if (item.kind === 'thinking' && item.active) return { ...item, active: false };
              return item;
            });
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
            return [...finalized, newItem];
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
          setItems((prev) =>
            prev.map((item) => {
              if (item.kind === 'tool_call' && item.toolCallId === tcu.toolCallId) {
                return {
                  ...item,
                  status: (tcu.status as ToolCallItem['status']) ?? item.status,
                  title: tcu.title ?? item.title,
                  content: tcu.content ? tcu.content.map(mapToolCallContent) : item.content,
                };
              }
              return item;
            })
          );
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
              return [...prev.slice(0, existing), planItem, ...prev.slice(existing + 1)];
            }
            return [...prev, planItem];
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
          setItems((prev) => [
            ...prev,
            { kind: 'raw_fallback', id: nextId(), data: update, timestamp: now },
          ]);
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
        setItems((prev) =>
          prev.map((item) => {
            if (item.kind === 'agent_message' && item.streaming) return { ...item, streaming: false };
            if (item.kind === 'thinking' && item.active) return { ...item, active: false };
            return item;
          })
        );
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
    setItems((prev) => [...prev, {
      kind: 'user_message',
      id: nextId(),
      text,
      timestamp: Date.now(),
    }]);
  }, []);

  const clear = useCallback(() => {
    setItems([]);
    setUsage({ inputTokens: 0, outputTokens: 0, totalTokens: 0 });
    if (sessionId && typeof sessionStorage !== 'undefined') {
      try {
        sessionStorage.removeItem(`${STORAGE_KEY_PREFIX}${sessionId}`);
      } catch {
        // ignore
      }
    }
  }, [sessionId]);

  return { items, usage, availableCommands, processMessage, addUserMessage, clear };
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
