import { act, renderHook } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { useAgentChat } from '../../../src/hooks/useAgentChat';

// ---------------------------------------------------------------------------
// Mock fetch + crypto
// ---------------------------------------------------------------------------

let fetchMock: ReturnType<typeof vi.fn>;
let uuidCounter = 0;

beforeEach(() => {
  uuidCounter = 0;
  vi.stubGlobal('crypto', {
    randomUUID: () => `uuid-${++uuidCounter}`,
  });
  fetchMock = vi.fn();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// Helper: create a ReadableStream from SSE lines
function sseStream(events: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  const text = events.map((e) => `data: ${e}\n\n`).join('');
  return new ReadableStream({
    start(controller) {
      controller.enqueue(encoder.encode(text));
      controller.close();
    },
  });
}

// Helper: mock the conversations endpoint (empty)
function mockEmptyConversations() {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ conversations: [] }),
  });
}

// Helper: mock the conversations endpoint with an existing conversation
function mockExistingConversation(convId: string, messages: Array<{ id: string; role: string; content: string; sequence: number; created_at: string; tool_calls_json: string | null; tool_call_id: string | null }>) {
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ conversations: [{ id: convId, title: null }] }),
  });
  fetchMock.mockResolvedValueOnce({
    ok: true,
    json: async () => ({ messages }),
  });
}

describe('useAgentChat', () => {
  describe('initialization', () => {
    it('loads empty conversation history on mount', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      // Initially loading
      expect(result.current.isLoadingHistory).toBe(true);
      expect(result.current.messages).toEqual([]);

      // Wait for loading to complete
      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      expect(result.current.messages).toEqual([]);
      expect(result.current.conversationId).toBeNull();
    });

    it('loads existing conversation history on mount', async () => {
      mockExistingConversation('conv-1', [
        { id: 'm1', role: 'user', content: 'Hello', sequence: 1, created_at: '2026-04-28T10:00:00Z', tool_calls_json: null, tool_call_id: null },
        { id: 'm2', role: 'assistant', content: 'Hi there!', sequence: 2, created_at: '2026-04-28T10:00:01Z', tool_calls_json: null, tool_call_id: null },
      ]);

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      expect(result.current.conversationId).toBe('conv-1');
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[0].content).toBe('Hello');
      expect(result.current.messages[1].role).toBe('agent');
      expect(result.current.messages[1].content).toBe('Hi there!');
    });

    it('handles failed conversation fetch gracefully', async () => {
      fetchMock.mockResolvedValueOnce({ ok: false, status: 500 });

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      expect(result.current.messages).toEqual([]);
    });
  });

  describe('handleSend', () => {
    it('sends message and processes SSE text_delta events', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      // Set input
      act(() => {
        result.current.setInputValue('Hello agent');
      });

      // Mock the chat POST response with SSE stream
      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: sseStream([
          JSON.stringify({ type: 'conversation_started', conversationId: 'new-conv' }),
          JSON.stringify({ type: 'text_delta', content: 'Hello ' }),
          JSON.stringify({ type: 'text_delta', content: 'world!' }),
          JSON.stringify({ type: 'done' }),
        ]),
      });

      // Send
      await act(async () => {
        await result.current.handleSend();
      });

      // Should have user message + agent response
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[0].role).toBe('user');
      expect(result.current.messages[0].content).toBe('Hello agent');
      expect(result.current.messages[1].role).toBe('agent');
      expect(result.current.messages[1].content).toBe('Hello world!');
      expect(result.current.messages[1].isStreaming).toBe(false);

      // Conversation ID should be set
      expect(result.current.conversationId).toBe('new-conv');

      // Input should be cleared
      expect(result.current.inputValue).toBe('');
      expect(result.current.isSending).toBe(false);
    });

    it('handles tool_start and tool_result events', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      act(() => {
        result.current.setInputValue('Search tasks');
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: sseStream([
          JSON.stringify({ type: 'conversation_started', conversationId: 'conv-2' }),
          JSON.stringify({ type: 'tool_start', tool: 'list_tasks' }),
          JSON.stringify({ type: 'tool_result', tool: 'list_tasks', result: { tasks: [] } }),
          JSON.stringify({ type: 'text_delta', content: 'No tasks found.' }),
          JSON.stringify({ type: 'done' }),
        ]),
      });

      await act(async () => {
        await result.current.handleSend();
      });

      const agentMsg = result.current.messages[1];
      expect(agentMsg.toolCalls).toHaveLength(1);
      expect(agentMsg.toolCalls![0].name).toBe('list_tasks');
      expect(agentMsg.toolCalls![0].result).toEqual({ tasks: [] });
      expect(agentMsg.content).toBe('No tasks found.');
    });

    it('handles error events from the stream', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      act(() => {
        result.current.setInputValue('Do something');
      });

      fetchMock.mockResolvedValueOnce({
        ok: true,
        body: sseStream([
          JSON.stringify({ type: 'conversation_started', conversationId: 'conv-3' }),
          JSON.stringify({ type: 'error', message: 'Rate limit exceeded' }),
        ]),
      });

      await act(async () => {
        await result.current.handleSend();
      });

      const agentMsg = result.current.messages[1];
      expect(agentMsg.content).toContain('Rate limit exceeded');
      expect(agentMsg.isStreaming).toBe(false);
    });

    it('does not send empty messages', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      // Input is empty by default
      await act(async () => {
        await result.current.handleSend();
      });

      // No new messages, no fetch call for chat
      expect(result.current.messages).toEqual([]);
      // Only the initial conversations fetch was called
      expect(fetchMock).toHaveBeenCalledTimes(1);
    });

    it('handles HTTP error response from chat endpoint', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      act(() => {
        result.current.setInputValue('Hello');
      });

      fetchMock.mockResolvedValueOnce({
        ok: false,
        status: 500,
        json: async () => ({ error: 'Internal error' }),
      });

      await act(async () => {
        await result.current.handleSend();
      });

      // User message added, agent message shows error
      expect(result.current.messages).toHaveLength(2);
      expect(result.current.messages[1].content).toContain('Internal error');
      expect(result.current.isSending).toBe(false);
    });
  });

  describe('input management', () => {
    it('updates inputValue via setInputValue', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      act(() => {
        result.current.setInputValue('test message');
      });

      expect(result.current.inputValue).toBe('test message');
    });

    it('supports functional updates to inputValue', async () => {
      mockEmptyConversations();

      const { result } = renderHook(() => useAgentChat({ apiBase: '/api/test' }));

      await vi.waitFor(() => {
        expect(result.current.isLoadingHistory).toBe(false);
      });

      act(() => {
        result.current.setInputValue('hello');
      });
      act(() => {
        result.current.setInputValue((prev) => `${prev} world`);
      });

      expect(result.current.inputValue).toBe('hello world');
    });
  });
});
