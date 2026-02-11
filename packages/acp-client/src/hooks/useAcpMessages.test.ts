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
