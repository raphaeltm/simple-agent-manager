import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAcpMessages } from './useAcpMessages';
import type { AcpMessage } from './useAcpSession';

function sessionUpdateMessage(update: Record<string, unknown>): AcpMessage {
  return {
    jsonrpc: '2.0',
    method: 'session/update',
    params: { update },
  } as AcpMessage;
}

describe('useAcpMessages tool call parsing', () => {
  it('extracts nested terminal text content from tool_call payloads', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-1',
        title: '`pwd`',
        status: 'completed',
        content: [
          {
            type: 'terminal',
            output: [{ type: 'text', text: '/workspaces/hono' }],
          },
        ],
      }));
    });

    const item = result.current.items.find((entry) => entry.kind === 'tool_call');
    expect(item?.kind).toBe('tool_call');

    if (item?.kind !== 'tool_call') {
      throw new Error('expected tool_call item');
    }

    expect(item.content).toHaveLength(1);
    expect(item.content[0]).toMatchObject({
      type: 'terminal',
      text: '/workspaces/hono',
    });
  });

  it('updates existing tool call content from nested tool_call_update payloads', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'tool_call',
        toolCallId: 'tc-2',
        title: 'Terminal execute',
        status: 'in_progress',
      }));

      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'tool_call_update',
        toolCallId: 'tc-2',
        status: 'completed',
        content: [
          {
            type: 'content',
            content: [
              { type: 'text', text: 'Command completed successfully' },
            ],
          },
        ],
      }));
    });

    const item = result.current.items.find(
      (entry) => entry.kind === 'tool_call' && entry.toolCallId === 'tc-2'
    );
    expect(item?.kind).toBe('tool_call');

    if (item?.kind !== 'tool_call') {
      throw new Error('expected updated tool_call item');
    }

    expect(item.status).toBe('completed');
    expect(item.content[0]).toMatchObject({
      type: 'content',
      text: 'Command completed successfully',
    });
  });
});

describe('useAcpMessages available_commands_update', () => {
  it('returns empty availableCommands before first update', () => {
    const { result } = renderHook(() => useAcpMessages());
    expect(result.current.availableCommands).toEqual([]);
  });

  it('parses available_commands_update notification into SlashCommand array', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Compress conversation context' },
          { name: 'model', description: 'Switch between models' },
          { name: 'help' },
        ],
      }));
    });

    expect(result.current.availableCommands).toHaveLength(3);
    expect(result.current.availableCommands[0]).toEqual({
      name: 'compact',
      description: 'Compress conversation context',
      source: 'agent',
    });
    expect(result.current.availableCommands[1]).toEqual({
      name: 'model',
      description: 'Switch between models',
      source: 'agent',
    });
    // Commands without description should default to empty string
    expect(result.current.availableCommands[2]).toEqual({
      name: 'help',
      description: '',
      source: 'agent',
    });
  });

  it('replaces previous commands on subsequent updates', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'First' },
          { name: 'model', description: 'Second' },
        ],
      }));
    });

    expect(result.current.availableCommands).toHaveLength(2);

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'review', description: 'Review code' },
        ],
      }));
    });

    expect(result.current.availableCommands).toHaveLength(1);
    expect(result.current.availableCommands[0]?.name).toBe('review');
  });

  it('does not add available_commands_update to conversation items', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'available_commands_update',
        availableCommands: [
          { name: 'compact', description: 'Compress' },
        ],
      }));
    });

    expect(result.current.items).toHaveLength(0);
  });

  it('handles missing availableCommands field gracefully', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'available_commands_update',
        // No availableCommands field
      }));
    });

    expect(result.current.availableCommands).toEqual([]);
  });
});

describe('useAcpMessages clear', () => {
  it('clears all messages and resets usage', () => {
    const { result } = renderHook(() => useAcpMessages());

    // Add some messages
    act(() => {
      result.current.addUserMessage('Hello');
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hi there' },
      }));
    });

    expect(result.current.items).toHaveLength(2);

    act(() => {
      result.current.clear();
    });

    expect(result.current.items).toHaveLength(0);
    expect(result.current.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('preserves availableCommands after clear', () => {
    const { result } = renderHook(() => useAcpMessages());

    // Set some commands
    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'Compress' }],
      }));
    });

    // Add and clear messages
    act(() => {
      result.current.addUserMessage('Hello');
      result.current.clear();
    });

    // Commands should persist
    expect(result.current.availableCommands).toHaveLength(1);
    expect(result.current.items).toHaveLength(0);
  });

  it('does not touch localStorage or sessionStorage', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.addUserMessage('Hello');
      result.current.clear();
    });

    // No storage should be used — messages are server-managed via LoadSession
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('useAcpMessages starts empty (no persistence)', () => {
  it('starts with empty items and no storage access', () => {
    const { result } = renderHook(() => useAcpMessages());

    expect(result.current.items).toHaveLength(0);
    expect(result.current.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });

  it('accumulates messages from processMessage without persistence', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.addUserMessage('First');
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Response' },
      }));
    });

    expect(result.current.items).toHaveLength(2);
    // Nothing written to storage
    expect(localStorage.length).toBe(0);
    expect(sessionStorage.length).toBe(0);
  });
});

describe('useAcpMessages prepareForReplay', () => {
  it('clears items, usage, and availableCommands', () => {
    const { result } = renderHook(() => useAcpMessages());

    // Populate some state
    act(() => {
      result.current.addUserMessage('Hello');
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hi there' },
      }));
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'available_commands_update',
        availableCommands: [{ name: 'compact', description: 'Compress' }],
      }));
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.availableCommands).toHaveLength(1);

    act(() => {
      result.current.prepareForReplay();
    });

    expect(result.current.items).toHaveLength(0);
    expect(result.current.availableCommands).toHaveLength(0);
    expect(result.current.usage).toEqual({
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
    });
  });

  it('allows new messages to accumulate after prepareForReplay', () => {
    const { result } = renderHook(() => useAcpMessages());

    // Add initial messages
    act(() => {
      result.current.addUserMessage('Old message');
    });

    expect(result.current.items).toHaveLength(1);

    // Prepare for replay (simulates reconnect)
    act(() => {
      result.current.prepareForReplay();
    });

    expect(result.current.items).toHaveLength(0);

    // Simulate replayed messages arriving
    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Replayed user message' },
      }));
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Replayed agent message' },
      }));
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0]!.kind).toBe('user_message');
    expect(result.current.items[1]!.kind).toBe('agent_message');
  });
});

describe('useAcpMessages user_message_chunk (LoadSession replay)', () => {
  it('renders replayed user messages as user_message items', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'What is 2+2?' },
      }));
    });

    expect(result.current.items).toHaveLength(1);
    const item = result.current.items[0]!;
    expect(item.kind).toBe('user_message');
    if (item.kind === 'user_message') {
      expect(item.text).toBe('What is 2+2?');
    }
  });

  it('ignores empty user_message_chunk content', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: '' },
      }));
    });

    expect(result.current.items).toHaveLength(0);
  });

  it('replays a full conversation (user + agent) from LoadSession', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'user_message_chunk',
        content: { type: 'text', text: 'Hello' },
      }));
      result.current.processMessage(sessionUpdateMessage({
        sessionUpdate: 'agent_message_chunk',
        content: { type: 'text', text: 'Hi there!' },
      }));
    });

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0]!.kind).toBe('user_message');
    expect(result.current.items[1]!.kind).toBe('agent_message');
  });
});
