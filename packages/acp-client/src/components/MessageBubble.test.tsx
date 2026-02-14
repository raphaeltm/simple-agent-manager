import { describe, expect, it } from 'vitest';
import { render } from '@testing-library/react';
import { MessageBubble } from './MessageBubble';

describe('MessageBubble', () => {
  describe('code blocks', () => {
    it('renders fenced code blocks with overflow-x-auto for horizontal scrolling', () => {
      const markdown = '```typescript\nconst veryLongVariableName = "this is a very long string that should cause horizontal scrolling on mobile devices";\n```';
      const { container } = render(
        <MessageBubble text={markdown} role="agent" />
      );

      const pre = container.querySelector('pre');
      expect(pre).not.toBeNull();
      expect(pre!.className).toContain('overflow-x-auto');
      expect(pre!.className).toContain('whitespace-pre');
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
});
