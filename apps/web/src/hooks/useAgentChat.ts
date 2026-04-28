/**
 * Shared hook for agent chat UIs (SAM top-level + per-project agent).
 *
 * Encapsulates: SSE streaming, conversation history loading, message state.
 * Consumers provide the API base URL and agent display label.
 */
import type React from 'react';
import { useCallback, useEffect, useRef, useState } from 'react';

import { API_URL } from '../lib/api/client';

export interface ChatMessage {
  id: string;
  role: 'user' | 'agent';
  content: string;
  timestamp: string;
  toolCalls?: Array<{ name: string; result?: unknown }>;
  isStreaming?: boolean;
}

function formatTimestamp(isoOrDatetime: string): string {
  try {
    const d = new Date(isoOrDatetime);
    if (isNaN(d.getTime())) return '';
    return d.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
  } catch {
    return '';
  }
}

function nowTimestamp(): string {
  return new Date().toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' });
}

export interface UseAgentChatOptions {
  /** API path prefix, e.g. "/api/sam" or "/api/projects/abc/agent" */
  apiBase: string;
}

export interface UseAgentChatReturn {
  messages: ChatMessage[];
  isSending: boolean;
  isLoadingHistory: boolean;
  conversationId: string | null;
  inputValue: string;
  setInputValue: React.Dispatch<React.SetStateAction<string>>;
  handleSend: () => Promise<void>;
}

export function useAgentChat({ apiBase }: UseAgentChatOptions): UseAgentChatReturn {
  const [inputValue, setInputValue] = useState('');
  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [isSending, setIsSending] = useState(false);
  const [isLoadingHistory, setIsLoadingHistory] = useState(true);
  const abortRef = useRef<AbortController | null>(null);

  // Load existing conversation on mount
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const convResp = await fetch(`${API_URL}${apiBase}/conversations?type=human`, {
          credentials: 'include',
        });
        if (!convResp.ok || cancelled) {
          setIsLoadingHistory(false);
          return;
        }
        const convData = (await convResp.json()) as {
          conversations: Array<{ id: string; title: string | null }>;
        };
        if (cancelled) return;

        const conv = convData.conversations[0];
        if (!conv) {
          setIsLoadingHistory(false);
          return;
        }

        setConversationId(conv.id);

        const msgResp = await fetch(
          `${API_URL}${apiBase}/conversations/${conv.id}/messages?limit=200`,
          { credentials: 'include' },
        );
        if (!msgResp.ok || cancelled) {
          setIsLoadingHistory(false);
          return;
        }
        const msgData = (await msgResp.json()) as {
          messages: Array<{
            id: string;
            role: string;
            content: string;
            tool_calls_json: string | null;
            tool_call_id: string | null;
            sequence: number;
            created_at: string;
          }>;
        };
        if (cancelled) return;

        const mapped: ChatMessage[] = [];
        for (const row of msgData.messages) {
          if (row.role === 'user') {
            mapped.push({
              id: row.id,
              role: 'user',
              content: row.content,
              timestamp: formatTimestamp(row.created_at),
            });
          } else if (row.role === 'assistant') {
            let toolCalls: Array<{ name: string; result?: unknown }> | undefined;
            if (row.tool_calls_json) {
              try {
                const parsed = JSON.parse(row.tool_calls_json) as Array<{
                  id: string;
                  name: string;
                  input: unknown;
                }>;
                toolCalls = parsed.map((tc) => ({ name: tc.name }));
              } catch {
                // ignore parse errors
              }
            }
            mapped.push({
              id: row.id,
              role: 'agent',
              content: row.content,
              timestamp: formatTimestamp(row.created_at),
              toolCalls,
            });
          } else if (row.role === 'tool_result' && row.tool_call_id) {
            const lastAgent = [...mapped].reverse().find((m) => m.role === 'agent' && m.toolCalls);
            if (lastAgent?.toolCalls) {
              const pendingCall = lastAgent.toolCalls.find((tc) => !tc.result);
              if (pendingCall) {
                try {
                  pendingCall.result = JSON.parse(row.content);
                } catch {
                  pendingCall.result = row.content;
                }
              }
            }
          }
        }

        setMessages(mapped);
      } catch {
        // Silently handle — user just sees empty chat
      } finally {
        if (!cancelled) setIsLoadingHistory(false);
      }
    })();
    return () => { cancelled = true; };
  }, [apiBase]);

  /** Send a message and stream the response via SSE. */
  const handleSend = useCallback(async () => {
    const text = inputValue.trim();
    if (!text || isSending) return;

    setInputValue('');
    setIsSending(true);

    const userMsg: ChatMessage = {
      id: crypto.randomUUID(),
      role: 'user',
      content: text,
      timestamp: nowTimestamp(),
    };
    setMessages((prev) => [...prev, userMsg]);

    const agentMsgId = crypto.randomUUID();
    setMessages((prev) => [
      ...prev,
      {
        id: agentMsgId,
        role: 'agent',
        content: '',
        timestamp: nowTimestamp(),
        toolCalls: [],
        isStreaming: true,
      },
    ]);

    try {
      abortRef.current = new AbortController();
      const response = await fetch(`${API_URL}${apiBase}/chat`, {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ conversationId, message: text }),
        signal: abortRef.current.signal,
      });

      if (!response.ok) {
        const errData = await response.json().catch(() => ({ error: 'Unknown error' }));
        throw new Error((errData as { error?: string }).error || `HTTP ${response.status}`);
      }

      if (!response.body) throw new Error('No response body');

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';
      let streamDone = false;

      while (!streamDone) {
        const { done, value } = await reader.read();
        if (done) {
          streamDone = true;
          break;
        }

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (!data || data === '[DONE]') continue;

          let event: Record<string, unknown>;
          try {
            event = JSON.parse(data) as Record<string, unknown>;
          } catch {
            continue;
          }

          const eventType = event.type as string;

          if (eventType === 'conversation_started') {
            setConversationId(event.conversationId as string);
          } else if (eventType === 'text_delta') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId
                  ? { ...m, content: m.content + (event.content as string) }
                  : m,
              ),
            );
          } else if (eventType === 'tool_start') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId
                  ? {
                      ...m,
                      toolCalls: [...(m.toolCalls || []), { name: event.tool as string }],
                    }
                  : m,
              ),
            );
          } else if (eventType === 'tool_result') {
            setMessages((prev) =>
              prev.map((m) => {
                if (m.id !== agentMsgId) return m;
                const calls = [...(m.toolCalls || [])];
                const idx = calls.findIndex((tc) => tc.name === event.tool && !tc.result);
                if (idx >= 0) calls[idx] = { name: calls[idx]!.name, result: event.result };
                return { ...m, toolCalls: calls };
              }),
            );
          } else if (eventType === 'error') {
            setMessages((prev) =>
              prev.map((m) =>
                m.id === agentMsgId
                  ? {
                      ...m,
                      content: m.content + `\n\n**Error:** ${event.message as string}`,
                      isStreaming: false,
                    }
                  : m,
              ),
            );
          } else if (eventType === 'done') {
            setMessages((prev) =>
              prev.map((m) => (m.id === agentMsgId ? { ...m, isStreaming: false } : m)),
            );
          }
        }
      }

      setMessages((prev) =>
        prev.map((m) => (m.id === agentMsgId ? { ...m, isStreaming: false } : m)),
      );
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === agentMsgId
            ? {
                ...m,
                content: m.content || `Failed to get response: ${(err as Error).message}`,
                isStreaming: false,
              }
            : m,
        ),
      );
    } finally {
      setIsSending(false);
      abortRef.current = null;
    }
  }, [inputValue, isSending, conversationId, apiBase]);

  return {
    messages,
    isSending,
    isLoadingHistory,
    conversationId,
    inputValue,
    setInputValue,
    handleSend,
  };
}
