import { describe, expect, it } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { ToolCallCard } from './ToolCallCard';
import type { ToolCallItem } from '../hooks/useAcpMessages';

function createToolCall(overrides: Partial<ToolCallItem> = {}): ToolCallItem {
  return {
    kind: 'tool_call',
    id: 'item-1',
    toolCallId: 'tool-1',
    title: 'Terminal execute',
    toolKind: 'execute',
    status: 'completed',
    content: [],
    locations: [],
    timestamp: 1,
    ...overrides,
  };
}

describe('ToolCallCard', () => {
  it('does not expose expandable affordance when content is empty', () => {
    const toolCall = createToolCall({
      content: [{ type: 'content', text: '', data: {} }],
    });

    render(<ToolCallCard toolCall={toolCall} />);

    const header = screen.getByRole('button', { name: /terminal execute/i });
    expect(header.className).toContain('cursor-default');

    fireEvent.click(header);
    expect(document.querySelector('.border-t.border-gray-200')).toBeNull();
  });

  it('renders fallback JSON when tool content has data but no text', () => {
    const toolCall = createToolCall({
      content: [
        {
          type: 'content',
          data: { exitCode: 0, command: 'pwd' },
        },
      ],
    });

    render(<ToolCallCard toolCall={toolCall} />);

    const header = screen.getByRole('button', { name: /terminal execute/i });
    expect(header.className).toContain('cursor-pointer');

    fireEvent.click(header);

    expect(screen.getByText(/"exitCode": 0/)).toBeTruthy();
    expect(screen.getByText(/"command": "pwd"/)).toBeTruthy();
  });

  it('renders terminal output when text content exists', () => {
    const toolCall = createToolCall({
      content: [
        {
          type: 'terminal',
          text: '/workspaces/hono',
          data: { output: '/workspaces/hono' },
        },
      ],
    });

    render(<ToolCallCard toolCall={toolCall} />);

    fireEvent.click(screen.getByRole('button', { name: /terminal execute/i }));

    expect(screen.getByText('/workspaces/hono')).toBeTruthy();
  });
});
