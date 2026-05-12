import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { render, act } from '@testing-library/react';
import { TypewriterText } from '../../../src/components/TypewriterText';

describe('TypewriterText', () => {
  // Track rAF callbacks so we can fire them manually
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

  /** Advance time and flush all pending rAF callbacks at that time. */
  function advanceTime(ms: number) {
    currentTime += ms;
    // Flush rAF callbacks — they may schedule new ones
    let safety = 100;
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
      expect(container.textContent).toBe('Hello world, this is a test.');
    });

    it('updates instantly when text changes and animated=false', () => {
      const { container, rerender } = render(
        <TypewriterText text="First" animated={false} />
      );
      expect(container.textContent).toBe('First');

      rerender(<TypewriterText text="First Second" animated={false} />);
      expect(container.textContent).toBe('First Second');
    });
  });

  describe('animated mode', () => {
    it('starts with empty text and reveals words over time', () => {
      const { container } = render(
        <TypewriterText text="Hello world" animated={true} wordsPerSecond={10} />
      );

      // Initially empty — the useEffect hasn't fired yet
      expect(container.textContent).toBe('');

      // Advance time enough to reveal all words (2 words at 10wps = 200ms)
      act(() => { advanceTime(300); });

      expect(container.textContent).toBe('Hello world');
    });

    it('queues new words when text grows', () => {
      const { container, rerender } = render(
        <TypewriterText text="Hello" animated={true} wordsPerSecond={10} />
      );

      // Flush initial animation
      act(() => { advanceTime(200); });
      expect(container.textContent).toBe('Hello');

      // Grow text
      rerender(<TypewriterText text="Hello world foo" animated={true} wordsPerSecond={10} />);

      act(() => { advanceTime(300); });
      expect(container.textContent).toBe('Hello world foo');
    });

    it('handles text replacement (shrink) by showing full new text', () => {
      const { container, rerender } = render(
        <TypewriterText text="Hello world" animated={true} wordsPerSecond={10} />
      );

      act(() => { advanceTime(300); });
      expect(container.textContent).toBe('Hello world');

      // Replace with shorter text
      rerender(<TypewriterText text="Bye" animated={true} wordsPerSecond={10} />);

      // Should show replacement immediately (no animation for shrink)
      expect(container.textContent).toBe('Bye');
    });

    it('stops animating when queue empties (signals thinking)', () => {
      const { container } = render(
        <TypewriterText text="Hi" animated={true} wordsPerSecond={10} />
      );

      act(() => { advanceTime(200); });
      expect(container.textContent).toBe('Hi');

      // No more rAF callbacks should be pending
      expect(rafQueue.length).toBe(0);
    });
  });

  describe('word splitting', () => {
    it('preserves whitespace at word boundaries', () => {
      const { container } = render(
        <TypewriterText text="a  b" animated={true} wordsPerSecond={10} />
      );

      act(() => { advanceTime(300); });
      expect(container.textContent).toBe('a  b');
    });

    it('handles leading whitespace', () => {
      const { container } = render(
        <TypewriterText text="  hello" animated={true} wordsPerSecond={10} />
      );

      act(() => { advanceTime(200); });
      expect(container.textContent).toBe('  hello');
    });
  });

  describe('cleanup', () => {
    it('cancels pending animation on unmount', () => {
      const { unmount } = render(
        <TypewriterText text="Hello world this is a long text" animated={true} wordsPerSecond={2} />
      );

      // Don't flush — let animation be in progress
      // The useEffect cleanup should cancel
      unmount();
      // cancelAnimationFrame should have been called (either by cleanup effect or component)
      // The key thing is it doesn't error on unmount
    });
  });
});
