import { useCallback, useRef, useState } from 'react';

import type { SlashCommand } from '../types';
import {
  asAvailableCommandsUpdate,
  asPlanUpdate,
  asPromptResult,
  asToolCallPatchUpdate,
  asToolCallUpdate,
  getSessionMessageOrigin,
  getSessionUpdate,
  getTextContent,
  isAgentCrashReport,
} from './useAcpMessagePayloads';
import {
  enforceItemCap,
  finalizeStreamingItems,
  mapToolCallContent,
  MAX_ITEM_TEXT_LENGTH,
  nextConversationItemId,
  updateLastItem,
} from './useAcpMessages.helpers';
import type {
  AcpMessagesHandle,
  AgentMessage,
  ConversationItem,
  PlanItem,
  ThinkingItem,
  TokenUsage,
  ToolCallItem,
} from './useAcpMessages.types';
import type { AcpMessage } from './useAcpSession';

export { mapToolCallContent } from './useAcpMessages.helpers';
export type {
  AcpMessagesHandle,
  AgentCrashReportItem,
  AgentMessage,
  ConversationItem,
  PlanItem,
  RawFallback,
  SystemMessage,
  ThinkingItem,
  TokenUsage,
  ToolCallContentItem,
  ToolCallItem,
  UserMessage,
} from './useAcpMessages.types';

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
  const [usage, setUsage] = useState<TokenUsage>({
    inputTokens: 0,
    outputTokens: 0,
    totalTokens: 0,
  });
  const [availableCommands, setAvailableCommands] = useState<SlashCommand[]>([]);

  // Track the last tool call index for efficient tool_call_update lookups.
  // Most updates target the most recently added tool call, so searching
  // backward from here avoids scanning the entire array.
  const lastToolCallIndexRef = useRef(-1);

  const processMessage = useCallback((msg: AcpMessage) => {
    if (isAgentCrashReport(msg)) {
      setItems((prev) =>
        enforceItemCap([
          ...prev,
          {
            kind: 'agent_crash_report',
            id: nextConversationItemId(),
            agentType: msg.agentType,
            recovered: msg.recovered,
            message: msg.message,
            attribution: msg.attribution,
            stderr: msg.stderr,
            stderrTruncated: msg.stderrTruncated,
            suggestion: msg.suggestion,
            recoveryError: msg.recoveryError,
            timestamp: Date.parse(msg.timestamp) || Date.now(),
          },
        ])
      );
      return;
    }

    // Handle session notifications (method === 'session/update')
    if (msg.method === 'session/update' && msg.params) {
      const update = getSessionUpdate(msg.params);
      if (!update) return;

      const now = Date.now();
      const messageOrigin = getSessionMessageOrigin(msg.params);

      switch (update.sessionUpdate) {
        case 'agent_message_chunk': {
          const text = getTextContent(update);
          setItems((prev) =>
            updateLastItem(
              prev,
              (item) => item.kind === 'agent_message' && (item as AgentMessage).streaming,
              (item) => {
                const am = item as AgentMessage;
                const newText =
                  am.text.length + text.length > MAX_ITEM_TEXT_LENGTH
                    ? am.text // Silently stop appending when cap reached
                    : am.text + text;
                return { ...am, text: newText };
              },
              () => ({
                kind: 'agent_message' as const,
                id: nextConversationItemId(),
                text,
                streaming: true,
                timestamp: now,
              })
            )
          );
          break;
        }

        case 'agent_thought_chunk': {
          const text = getTextContent(update);
          setItems((prev) =>
            updateLastItem(
              prev,
              (item) => item.kind === 'thinking' && (item as ThinkingItem).active,
              (item) => {
                const ti = item as ThinkingItem;
                const newText =
                  ti.text.length + text.length > MAX_ITEM_TEXT_LENGTH ? ti.text : ti.text + text;
                return { ...ti, text: newText };
              },
              () => ({
                kind: 'thinking' as const,
                id: nextConversationItemId(),
                text,
                active: true,
                timestamp: now,
              })
            )
          );
          break;
        }

        case 'user_message_chunk': {
          // User messages arrive here from two sources:
          // 1. LoadSession replay (restoring conversation on reconnect)
          // 2. Synthetic injection by the VM agent during live prompts
          //    (so the replay buffer and Durable Object have user messages)
          //
          // In the live case, addUserMessage() has already added the message
          // to the items list for instant UX. Deduplicate by checking if a
          // recent user_message with matching text already exists.
          const text = getTextContent(update);
          if (text) {
            setItems((prev) => {
              // Deduplicate: check last few items for a matching user message.
              // The addUserMessage call happens right before session/prompt is
              // sent, so the matching item is typically the last one or close.
              for (let i = prev.length - 1; i >= Math.max(0, prev.length - 5); i--) {
                const item = prev[i];
                if (!item) continue;
                if (
                  item.kind === 'user_message' &&
                  item.text === text &&
                  item.origin === messageOrigin
                ) {
                  return prev; // Already present — skip duplicate
                }
                // Stop scanning once we hit a non-user item (agent response
                // or tool call means the user message is from a prior turn).
                if (item.kind !== 'user_message') break;
              }
              return enforceItemCap([
                ...prev,
                {
                  kind: 'user_message',
                  id: nextConversationItemId(),
                  text,
                  timestamp: now,
                  origin: messageOrigin,
                },
              ]);
            });
          }
          break;
        }

        case 'tool_call': {
          const tc = asToolCallUpdate(update);
          // Finalize any streaming agent message or thinking block
          setItems((prev) => {
            const finalized = finalizeStreamingItems(prev);
            const newItem: ToolCallItem = {
              kind: 'tool_call',
              id: nextConversationItemId(),
              toolCallId: tc.toolCallId ?? '',
              title: tc.title ?? 'Tool Call',
              toolKind: tc.kind,
              status: tc.status ?? 'in_progress',
              content: (tc.content ?? []).map(mapToolCallContent),
              locations: tc.locations ?? [],
              timestamp: now,
              toolName: tc.toolName,
              rawInput: tc.rawInput,
              rawOutput: tc.rawOutput,
            };
            const result = enforceItemCap([...finalized, newItem]);
            lastToolCallIndexRef.current = result.length - 1;
            return result;
          });
          break;
        }

        case 'tool_call_update': {
          const tcu = asToolCallPatchUpdate(update);
          setItems((prev) => {
            // Search backward from the last known tool call index for efficiency.
            // Most tool_call_updates target the most recent tool call.
            let targetIdx = -1;
            const startIdx = Math.min(lastToolCallIndexRef.current, prev.length - 1);
            for (let i = startIdx; i >= 0; i--) {
              const item = prev[i];
              if (!item) continue;
              if (item.kind === 'tool_call' && item.toolCallId === tcu.toolCallId) {
                targetIdx = i;
                break;
              }
            }
            // Fallback: search forward from startIdx+1 in case of pruning
            if (targetIdx < 0) {
              for (let i = startIdx + 1; i < prev.length; i++) {
                const item = prev[i];
                if (!item) continue;
                if (item.kind === 'tool_call' && item.toolCallId === tcu.toolCallId) {
                  targetIdx = i;
                  break;
                }
              }
            }
            if (targetIdx < 0) return prev; // Not found — skip

            const target = prev[targetIdx];
            if (!target || target.kind !== 'tool_call') return prev;
            const updated: ToolCallItem = {
              ...target,
              status: tcu.status ?? target.status,
              title: tcu.title ?? target.title,
              content: tcu.content ? tcu.content.map(mapToolCallContent) : target.content,
              // Preserve-on-empty: the result update carries rawOutput + toolName;
              // a status-only patch must not erase the initial call's rawInput.
              toolName: tcu.toolName ?? target.toolName,
              rawInput: tcu.rawInput ?? target.rawInput,
              rawOutput: tcu.rawOutput ?? target.rawOutput,
            };
            const result = prev.slice(0);
            result[targetIdx] = updated;
            return result;
          });
          break;
        }

        case 'plan': {
          const plan = asPlanUpdate(update);
          setItems((prev) => {
            const existing = prev.findIndex((i) => i.kind === 'plan');
            const planItem: PlanItem = {
              kind: 'plan',
              id:
                existing >= 0
                  ? (prev[existing]?.id ?? nextConversationItemId())
                  : nextConversationItemId(),
              entries: plan.entries ?? [],
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
          const commandUpdate = asAvailableCommandsUpdate(update);
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

        case 'config_option_update': {
          // Acknowledged ACP notification: session selector state, not transcript content.
          break;
        }

        default: {
          // Unknown/unsupported update type — render as raw fallback
          setItems((prev) =>
            enforceItemCap([
              ...prev,
              {
                kind: 'raw_fallback',
                id: nextConversationItemId(),
                data: update,
                timestamp: now,
              },
            ])
          );
          break;
        }
      }
      return;
    }

    // Handle prompt responses (result with stopReason)
    const result = asPromptResult(msg.result);
    if (result) {
      if (result.stopReason) {
        // Finalize any streaming items
        setItems(finalizeStreamingItems);
        // Update token usage
        if (result.usage) {
          const usage = result.usage;
          setUsage((prev) => ({
            inputTokens: prev.inputTokens + usage.inputTokens,
            outputTokens: prev.outputTokens + usage.outputTokens,
            totalTokens: prev.totalTokens + usage.totalTokens,
          }));
        }
      }
    }
  }, []);

  const addUserMessage = useCallback((text: string) => {
    setItems((prev) =>
      enforceItemCap([
        ...prev,
        {
          kind: 'user_message',
          id: nextConversationItemId(),
          text,
          timestamp: Date.now(),
        },
      ])
    );
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

  return {
    items,
    usage,
    availableCommands,
    processMessage,
    addUserMessage,
    clear,
    prepareForReplay,
  };
}
