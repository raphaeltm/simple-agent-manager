import { act,render } from '@testing-library/react';
import { afterEach,beforeEach, describe, expect, it, vi } from 'vitest';

import { TypewriterText } from '../../../src/components/TypewriterText';
import { type RafMockState,setupRafMock } from '../helpers/raf-mock';

// Mock react-markdown to avoid complex JSX parsing in tests
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

describe('TypewriterText', () => {
  let raf: RafMockState;

  beforeEach(() => {
    raf = setupRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  describe('non-animated mode', () => {
    it('renders full text immediately when animated=false', () => {
      const { container } = render(
        <TypewriterText text="Hello world, this is a test." animated={false} />
      );
      expect(container.textContent).toContain('Hello world, this is a test.');
    });

    it('updates instantly when text changes and animated=false', () => {
      const { container, rerender } = render(
        <TypewriterText text="First" animated={false} />
      );
      expect(container.textContent).toContain('First');

      rerender(<TypewriterText text="First Second" animated={false} />);
      expect(container.textContent).toContain('First Second');
    });
  });

  describe('animated mode', () => {
    it('starts with empty text and reveals characters over time', () => {
      const { container } = render(
        <TypewriterText text="Hello" animated={true} charDelayMs={10} />
      );

      // Initially empty — useStreamingReveal starts at index 0
      expect(container.textContent).toBe('');

      // Advance enough to reveal all 5 chars (5 * 10ms = 50ms + buffer)
      act(() => { raf.advanceTime(100); });

      expect(container.textContent).toContain('Hello');
    });

    it('queues new characters when text grows', () => {
      const { container, rerender } = render(
        <TypewriterText text="Hi" animated={true} charDelayMs={10} />
      );

      act(() => { raf.advanceTime(100); });
      expect(container.textContent).toContain('Hi');

      rerender(<TypewriterText text="Hi there" animated={true} charDelayMs={10} />);

      act(() => { raf.advanceTime(200); });
      expect(container.textContent).toContain('Hi there');
    });

    it('handles text replacement by showing full new text', () => {
      const { container, rerender } = render(
        <TypewriterText text="Hello" animated={true} charDelayMs={10} />
      );

      act(() => { raf.advanceTime(200); });
      expect(container.textContent).toContain('Hello');

      // Replace with shorter text
      rerender(<TypewriterText text="Bye" animated={true} charDelayMs={10} />);

      // Should show replacement immediately
      expect(container.textContent).toContain('Bye');
    });

    it('shows streaming cursor while revealing', () => {
      const { container } = render(
        <TypewriterText text="Hello world this is long text" animated={true} charDelayMs={50} />
      );

      const cursor = container.querySelector('.streaming-cursor');
      expect(cursor).toBeTruthy();
    });

    it('removes cursor when fully revealed', () => {
      const { container } = render(
        <TypewriterText text="Hi" animated={true} charDelayMs={10} />
      );

      act(() => { raf.advanceTime(200); });

      const cursor = container.querySelector('.streaming-cursor');
      expect(cursor).toBeNull();
    });

    it('applies char-fade spans to newly revealed characters', () => {
      const { container } = render(
        <TypewriterText text="Hello" animated={true} charDelayMs={10} />
      );

      // Advance to reveal some characters
      act(() => { raf.advanceTime(50); });

      // char-fade spans should appear in the DOM via applyCharFade
      const spans = container.querySelectorAll('.char-fade');
      expect(spans.length).toBeGreaterThan(0);
    });

    it('cleans up char-fade spans after animation completes', () => {
      vi.useFakeTimers();

      const { container } = render(
        <TypewriterText
          text="Hi"
          animated={true}
          charDelayMs={10}
          fadeDurationMs={100}
          fadeStaggerMs={8}
        />
      );

      // Use real rAF mock to advance reveal
      act(() => { raf.advanceTime(100); });

      // Spans should be present
      expect(container.querySelectorAll('.char-fade').length).toBeGreaterThan(0);

      // Advance past cleanup timer (delta * fadeStaggerMs + fadeDurationMs + 50)
      act(() => { vi.advanceTimersByTime(500); });

      // Spans should be cleaned up
      expect(container.querySelectorAll('.char-fade').length).toBe(0);
      // Text should still be present
      expect(container.textContent).toContain('Hi');

      vi.useRealTimers();
    });
  });

  describe('markdown rendering', () => {
    it('renders through react-markdown', () => {
      const { container } = render(
        <TypewriterText text="**bold**" animated={false} />
      );
      const md = container.querySelector('[data-testid="markdown"]');
      expect(md).toBeTruthy();
      expect(md?.textContent).toBe('**bold**');
    });
  });

  describe('cleanup', () => {
    it('cancels pending animation on unmount', () => {
      const { unmount } = render(
        <TypewriterText text="Hello world this is a long text" animated={true} charDelayMs={50} />
      );

      unmount();
      // Should not error on unmount
    });
  });
});
