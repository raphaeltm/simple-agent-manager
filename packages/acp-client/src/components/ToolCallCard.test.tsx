import { describe, expect, it, vi } from 'vitest';
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

  describe('onFileClick behavior', () => {
    it('renders location as clickable button when onFileClick is provided', () => {
      const onFileClick = vi.fn();
      const toolCall = createToolCall({
        locations: [{ path: 'src/index.ts', line: 42 }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} onFileClick={onFileClick} />);

      // The inner file button is the one with text-blue-600 class
      const fileButton = container.querySelector('button.text-blue-600');
      expect(fileButton).not.toBeNull();
      expect(fileButton!.textContent).toBe('src/index.ts:42');
    });

    it('renders location as plain span when onFileClick is not provided', () => {
      const toolCall = createToolCall({
        locations: [{ path: 'src/index.ts', line: 42 }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} />);

      // Should be a span, not a button
      const locationSpan = container.querySelector('span.text-gray-500.font-mono');
      expect(locationSpan).not.toBeNull();
      expect(locationSpan!.textContent).toBe('src/index.ts:42');

      // No blue clickable button should exist
      expect(container.querySelector('button.text-blue-600')).toBeNull();
    });

    it('calls onFileClick with path and line when location button is clicked', () => {
      const onFileClick = vi.fn();
      const toolCall = createToolCall({
        locations: [{ path: 'src/app.tsx', line: 10 }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} onFileClick={onFileClick} />);

      const fileButton = container.querySelector('button.text-blue-600')!;
      fireEvent.click(fileButton);

      expect(onFileClick).toHaveBeenCalledWith('src/app.tsx', 10);
      expect(onFileClick).toHaveBeenCalledTimes(1);
    });

    it('calls onFileClick with path and undefined line when location has no line', () => {
      const onFileClick = vi.fn();
      const toolCall = createToolCall({
        locations: [{ path: 'README.md' }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} onFileClick={onFileClick} />);

      const fileButton = container.querySelector('button.text-blue-600')!;
      fireEvent.click(fileButton);

      expect(onFileClick).toHaveBeenCalledWith('README.md', undefined);
    });

    it('stopPropagation prevents card expansion when clicking file location', () => {
      const onFileClick = vi.fn();
      const toolCall = createToolCall({
        content: [{ type: 'content', text: 'some output', data: null }],
        locations: [{ path: 'src/lib.ts', line: 5 }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} onFileClick={onFileClick} />);

      // Click the file button — should NOT expand the card
      const fileButton = container.querySelector('button.text-blue-600')!;
      fireEvent.click(fileButton);

      // Card content should NOT be visible (expansion prevented by stopPropagation)
      expect(screen.queryByText('some output')).toBeNull();
      expect(onFileClick).toHaveBeenCalledTimes(1);
    });
  });

  describe('overflow protection', () => {
    it('header uses min-w-0 on flex children to allow truncation', () => {
      const toolCall = createToolCall({
        locations: [{ path: '/very/long/deeply/nested/path/to/some/file/that/is/really/long.tsx', line: 42 }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} />);

      const header = container.querySelector('[role="button"]');
      expect(header).not.toBeNull();

      // The inner flex container should have min-w-0 to allow truncation
      const innerFlex = header!.querySelector('.min-w-0');
      expect(innerFlex).not.toBeNull();
    });

    it('status icon and chevron have shrink-0 to prevent squishing', () => {
      const toolCall = createToolCall({
        content: [{ type: 'content', text: 'output', data: null }],
        locations: [{ path: '/a/very/long/path.ts' }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} />);
      const header = container.querySelector('[role="button"]');

      // Status icon wrapper should have shrink-0
      const statusWrapper = header!.querySelector('.shrink-0');
      expect(statusWrapper).not.toBeNull();

      // Chevron SVG should have shrink-0
      const chevron = header!.querySelector('svg.shrink-0');
      expect(chevron).not.toBeNull();
    });

    it('tool content text area has break-words and overflow-hidden', () => {
      const longContent = 'a'.repeat(500) + '/very/long/unbreakable-file-path-that-goes-on-and-on.ts';
      const toolCall = createToolCall({
        content: [{ type: 'content', text: longContent, data: null }],
      });

      const { container } = render(<ToolCallCard toolCall={toolCall} />);
      fireEvent.click(screen.getByRole('button'));

      const contentDiv = container.querySelector('.break-words.overflow-hidden');
      expect(contentDiv).not.toBeNull();
      expect(contentDiv!.textContent).toContain(longContent);
    });
  });
});
