import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { TypewriterText } from '../../../src/components/TypewriterText';

// Mock react-markdown to avoid complex JSX parsing in tests
vi.mock('react-markdown', () => ({
  default: ({ children }: { children: string }) => <div data-testid="markdown">{children}</div>,
}));
vi.mock('remark-gfm', () => ({ default: () => {} }));

describe('TypewriterText', () => {
  let rafQueue: Array<{ id: number; cb: FrameRequestCallback }>;
  let nextRafId: number;
  let currentTime: number;

  beforeEach(() => {
    rafQueue = [];
    nextRafId = 1;
    currentTime = 0;

    vi.spyOn(window, 'requestAnimationFrame').mockImplementation((cb) => {
      const id = nextRafId++;
      rafQueue.push({ id, cb });
      return id;
    });
    vi.spyOn(window, 'cancelAnimationFrame').mockImplementation((id) => {
      rafQueue = rafQueue.filter((item) => item.id !== id);
    });
    vi.spyOn(performance, 'now').mockImplementation(() => currentTime);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  function advanceTime(ms: number) {
    currentTime += ms;
    let safety = 200;
    while (rafQueue.length > 0 && safety-- > 0) {
      const batch = [...rafQueue];
      rafQueue = [];
      for (const { cb } of batch) {
        cb(currentTime);
      }
    }
  }

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
      act(() => { advanceTime(100); });

      expect(container.textContent).toContain('Hello');
    });

    it('queues new characters when text grows', () => {
      const { container, rerender } = render(
        <TypewriterText text="Hi" animated={true} charDelayMs={10} />
      );

      act(() => { advanceTime(100); });
      expect(container.textContent).toContain('Hi');

      rerender(<TypewriterText text="Hi there" animated={true} charDelayMs={10} />);

      act(() => { advanceTime(200); });
      expect(container.textContent).toContain('Hi there');
    });

    it('handles text replacement by showing full new text', () => {
      const { container, rerender } = render(
        <TypewriterText text="Hello" animated={true} charDelayMs={10} />
      );

      act(() => { advanceTime(200); });
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

      act(() => { advanceTime(200); });

      const cursor = container.querySelector('.streaming-cursor');
      expect(cursor).toBeNull();
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
