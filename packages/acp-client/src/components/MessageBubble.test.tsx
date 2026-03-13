import { describe, expect, it, vi, beforeEach } from 'vitest';
import { render, screen } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';

// Verify React.memo is applied (component has $$typeof for memo)
describe('MessageBubble memoization', () => {
  it('is wrapped in React.memo', () => {
    expect(typeof MessageBubble).toBe('object');
    expect((MessageBubble as { $$typeof?: symbol }).$$typeof).toBe(Symbol.for('react.memo'));
  });

  it('skips re-render when props are identical', () => {
    const { rerender, container } = render(
      <MessageBubble text="Hello" role="agent" />
    );
    const firstHtml = container.innerHTML;

    rerender(<MessageBubble text="Hello" role="agent" />);
    const secondHtml = container.innerHTML;

    expect(firstHtml).toBe(secondHtml);
  });
});

describe('MessageBubble', () => {
  describe('code blocks', () => {
    it('renders fenced code blocks with syntax highlighting (colored tokens)', () => {
      const markdown = '```typescript\nconst x = 42;\n```';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre!.className).toContain('overflow-x-auto');

      // prism-react-renderer produces <span> elements with inline styles for token colors
      const tokenSpans = pre!.querySelectorAll('span[style]');
      expect(tokenSpans.length).toBeGreaterThan(0);
    });

    it('renders line numbers in fenced code blocks', () => {
      const markdown = '```js\nconst a = 1;\nconst b = 2;\nconst c = 3;\n```';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();

      // Line numbers are rendered as spans with the line number text
      expect(pre!.textContent).toContain('1');
      expect(pre!.textContent).toContain('2');
      expect(pre!.textContent).toContain('3');
    });

    it('does not double-wrap code blocks in nested <pre> elements', () => {
      const markdown = '```js\nconsole.log("hello");\n```';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const preElements = container.querySelectorAll('pre');
      // Should only have one <pre> (our custom one), not two (react-markdown + custom)
      expect(preElements.length).toBe(1);
    });

    it('renders inline code without <pre> wrapper', () => {
      const markdown = 'Use the `console.log` function';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const pre = container.querySelector('pre');
      expect(pre).toBeNull();

      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code!.className).toContain('font-mono');
    });

    it('does not have overflow-hidden on the prose wrapper', () => {
      const markdown = '```\nsome code\n```';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const proseDiv = container.querySelector('.prose');
      expect(proseDiv).not.toBeNull();
      expect(proseDiv!.className).not.toContain('overflow-hidden');
    });

    it('applies Night Owl theme background to code blocks', () => {
      const markdown = '```python\nprint("hello")\n```';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();
      // Night Owl theme uses #011627 as background (JSDOM normalizes to rgb)
      expect(pre!.style.background).toBe('rgb(1, 22, 39)');
    });
  });

  describe('inline code styling per role', () => {
    it('uses blue styling for inline code in user messages', () => {
      const { container } = render(
        <MessageBubble text="Use the `test` function" role="user" />
      );

      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code!.className).toContain('bg-blue-500');
      expect(code!.className).toContain('text-blue-50');
    });

    it('uses gray styling for inline code in agent messages', () => {
      const { container } = render(
        <MessageBubble text="Use the `test` function" role="agent" />
      );

      const code = container.querySelector('code');
      expect(code).not.toBeNull();
      expect(code!.className).toContain('bg-gray-100');
      expect(code!.className).toContain('text-gray-800');
    });
  });

  describe('message alignment', () => {
    it('left-aligns agent messages', () => {
      const { container } = render(
        <MessageBubble text="Hello" role="agent" />
      );

      const outerDiv = container.firstElementChild;
      expect(outerDiv!.className).toContain('justify-start');
    });

    it('right-aligns user messages', () => {
      const { container } = render(
        <MessageBubble text="Hello" role="user" />
      );

      const outerDiv = container.firstElementChild;
      expect(outerDiv!.className).toContain('justify-end');
    });
  });

  describe('streaming indicator', () => {
    it('shows streaming indicator when streaming is true', () => {
      const { container } = render(
        <MessageBubble text="thinking..." role="agent" streaming={true} />
      );

      const indicator = container.querySelector('.animate-pulse');
      expect(indicator).not.toBeNull();
    });

    it('hides streaming indicator when streaming is false', () => {
      const { container } = render(
        <MessageBubble text="done" role="agent" streaming={false} />
      );

      const indicator = container.querySelector('.animate-pulse');
      expect(indicator).toBeNull();
    });
  });

  describe('markdown features', () => {
    it('renders links with target=_blank', () => {
      const { container } = render(
        <MessageBubble text="Visit [example](https://example.com)" role="agent" />
      );

      const link = container.querySelector('a');
      expect(link).not.toBeNull();
      expect(link!.getAttribute('target')).toBe('_blank');
      expect(link!.getAttribute('rel')).toContain('noopener');
      expect(link!.textContent).toBe('example');
    });

    it('renders GFM tables', () => {
      const markdown = '| Col1 | Col2 |\n| --- | --- |\n| A | B |';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const table = container.querySelector('table');
      expect(table).not.toBeNull();
    });
  });

  describe('message actions', () => {
    beforeEach(() => {
      // Provide minimal speechSynthesis mock so the speaker button renders
      Object.defineProperty(window, 'speechSynthesis', {
        value: {
          speak: vi.fn(),
          cancel: vi.fn(),
          addEventListener: vi.fn(),
          removeEventListener: vi.fn(),
        },
        writable: true,
        configurable: true,
      });
      vi.stubGlobal('SpeechSynthesisUtterance', class {
        text: string;
        onend: (() => void) | null = null;
        onerror: (() => void) | null = null;
        constructor(text: string) { this.text = text; }
      });
      // Provide minimal clipboard mock so the copy button renders
      Object.defineProperty(navigator, 'clipboard', {
        value: { writeText: vi.fn().mockResolvedValue(undefined) },
        writable: true,
        configurable: true,
      });
    });

    it('shows action buttons for agent messages with timestamp', () => {
      render(<MessageBubble text="Hello" role="agent" timestamp={1710288000000} />);
      expect(screen.getByLabelText('Message info')).toBeTruthy();
      expect(screen.getByLabelText('Read aloud')).toBeTruthy();
      expect(screen.getByLabelText('Copy message')).toBeTruthy();
    });

    it('does not show action buttons for user messages', () => {
      render(<MessageBubble text="Hello" role="user" timestamp={1710288000000} />);
      expect(screen.queryByLabelText('Message info')).toBeNull();
      expect(screen.queryByLabelText('Read aloud')).toBeNull();
      expect(screen.queryByLabelText('Copy message')).toBeNull();
    });

    it('does not show action buttons for streaming agent messages', () => {
      render(<MessageBubble text="thinking..." role="agent" streaming={true} timestamp={1710288000000} />);
      expect(screen.queryByLabelText('Message info')).toBeNull();
    });

    it('does not show action buttons when timestamp is not provided', () => {
      render(<MessageBubble text="Hello" role="agent" />);
      expect(screen.queryByLabelText('Message info')).toBeNull();
    });

    it('does not show action buttons when timestamp is 0 (epoch)', () => {
      render(<MessageBubble text="Hello" role="agent" timestamp={0} />);
      expect(screen.queryByLabelText('Message info')).toBeNull();
    });
  });
});
