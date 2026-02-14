import { afterEach, describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useAcpMessages, cleanupStaleMessageStorage, ACP_MESSAGES_STORAGE_PREFIX } from './useAcpMessages';
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
});

describe('useAcpMessages localStorage persistence', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('persists messages to localStorage when sessionId is provided', () => {
    const sessionId = 'test-session-1';
    const { result } = renderHook(() => useAcpMessages({ sessionId }));

    act(() => {
      result.current.addUserMessage('Hello world');
    });

    const stored = localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}${sessionId}`);
    expect(stored).not.toBeNull();

    const parsed = JSON.parse(stored!);
    expect(parsed).toHaveLength(1);
    expect(parsed[0].kind).toBe('user_message');
    expect(parsed[0].text).toBe('Hello world');
  });

  it('restores messages from localStorage on mount', () => {
    const sessionId = 'test-session-2';

    // Pre-populate localStorage
    const messages = [
      { kind: 'user_message', id: 'item-1', text: 'Previous message', timestamp: 1000 },
      { kind: 'agent_message', id: 'item-2', text: 'Previous response', streaming: false, timestamp: 1001 },
    ];
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}${sessionId}`, JSON.stringify(messages));

    const { result } = renderHook(() => useAcpMessages({ sessionId }));

    expect(result.current.items).toHaveLength(2);
    expect(result.current.items[0]?.kind).toBe('user_message');
    expect(result.current.items[1]?.kind).toBe('agent_message');
  });

  it('finalizes streaming items when restoring from localStorage', () => {
    const sessionId = 'test-session-3';

    // Pre-populate with a streaming agent message (interrupted by disconnect)
    const messages = [
      { kind: 'agent_message', id: 'item-1', text: 'Partial response...', streaming: true, timestamp: 1000 },
      { kind: 'thinking', id: 'item-2', text: 'Thinking...', active: true, timestamp: 1001 },
    ];
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}${sessionId}`, JSON.stringify(messages));

    const { result } = renderHook(() => useAcpMessages({ sessionId }));

    // Streaming and thinking should be finalized on restore
    const agentMsg = result.current.items[0];
    expect(agentMsg?.kind).toBe('agent_message');
    if (agentMsg?.kind === 'agent_message') {
      expect(agentMsg.streaming).toBe(false);
    }

    const thinking = result.current.items[1];
    expect(thinking?.kind).toBe('thinking');
    if (thinking?.kind === 'thinking') {
      expect(thinking.active).toBe(false);
    }
  });

  it('clears localStorage when clear() is called with sessionId', () => {
    const sessionId = 'test-session-4';
    const { result } = renderHook(() => useAcpMessages({ sessionId }));

    act(() => {
      result.current.addUserMessage('Will be cleared');
    });

    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}${sessionId}`)).not.toBeNull();

    act(() => {
      result.current.clear();
    });

    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}${sessionId}`)).toBeNull();
  });

  it('does not persist when no sessionId is provided', () => {
    const { result } = renderHook(() => useAcpMessages());

    act(() => {
      result.current.addUserMessage('Not persisted');
    });

    // No localStorage keys should be set for acp-messages
    let acpKeyCount = 0;
    for (let i = 0; i < localStorage.length; i++) {
      if (localStorage.key(i)?.startsWith(ACP_MESSAGES_STORAGE_PREFIX)) {
        acpKeyCount++;
      }
    }
    expect(acpKeyCount).toBe(0);
  });

  it('handles corrupted localStorage data gracefully', () => {
    const sessionId = 'test-session-5';
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}${sessionId}`, 'not valid json {{{');

    const { result } = renderHook(() => useAcpMessages({ sessionId }));

    // Should start with empty items, not crash
    expect(result.current.items).toHaveLength(0);
  });
});

describe('cleanupStaleMessageStorage', () => {
  afterEach(() => {
    localStorage.clear();
  });

  it('removes localStorage entries for sessions not in the active set', () => {
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}active-1`, '[]');
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}active-2`, '[]');
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}stale-1`, '[]');
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}stale-2`, '[]');

    cleanupStaleMessageStorage(['active-1', 'active-2']);

    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}active-1`)).not.toBeNull();
    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}active-2`)).not.toBeNull();
    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}stale-1`)).toBeNull();
    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}stale-2`)).toBeNull();
  });

  it('does not remove non-acp localStorage entries', () => {
    localStorage.setItem('other-key', 'keep me');
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}stale`, '[]');

    cleanupStaleMessageStorage([]);

    expect(localStorage.getItem('other-key')).toBe('keep me');
    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}stale`)).toBeNull();
  });

  it('handles empty active session list by removing all acp entries', () => {
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}s1`, '[]');
    localStorage.setItem(`${ACP_MESSAGES_STORAGE_PREFIX}s2`, '[]');

    cleanupStaleMessageStorage([]);

    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}s1`)).toBeNull();
    expect(localStorage.getItem(`${ACP_MESSAGES_STORAGE_PREFIX}s2`)).toBeNull();
  });

  it('handles no existing acp entries gracefully', () => {
    localStorage.setItem('unrelated', 'value');

    // Should not throw
    cleanupStaleMessageStorage(['some-id']);

    expect(localStorage.getItem('unrelated')).toBe('value');
  });
});
