import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStreamingReveal } from '../../../src/hooks/useStreamingReveal';

describe('useStreamingReveal', () => {
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

  it('returns full text immediately when not animated', () => {
    const { result } = renderHook(() =>
      useStreamingReveal('Hello world', false)
    );
    expect(result.current.revealedText).toBe('Hello world');
    expect(result.current.isRevealing).toBe(false);
  });

  it('starts with empty string when animated', () => {
    const { result } = renderHook(() =>
      useStreamingReveal('Hello', true, { charDelayMs: 10 })
    );
    expect(result.current.revealedText).toBe('');
    expect(result.current.isRevealing).toBe(true);
  });

  it('reveals characters over time', () => {
    const { result } = renderHook(() =>
      useStreamingReveal('Hello', true, { charDelayMs: 10 })
    );

    act(() => { advanceTime(25); });
    // After 25ms at 10ms/char, should have revealed ~2 chars
    expect(result.current.revealedText.length).toBeGreaterThanOrEqual(2);

    act(() => { advanceTime(100); });
    expect(result.current.revealedText).toBe('Hello');
    expect(result.current.isRevealing).toBe(false);
  });

  it('extends reveal when text grows', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingReveal(text, true, { charDelayMs: 10 }),
      { initialProps: { text: 'Hi' } }
    );

    act(() => { advanceTime(100); });
    expect(result.current.revealedText).toBe('Hi');

    rerender({ text: 'Hi there' });

    act(() => { advanceTime(200); });
    expect(result.current.revealedText).toBe('Hi there');
  });

  it('snaps to new text on replacement (shrink)', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingReveal(text, true, { charDelayMs: 10 }),
      { initialProps: { text: 'Hello' } }
    );

    act(() => { advanceTime(200); });
    expect(result.current.revealedText).toBe('Hello');

    rerender({ text: 'Bye' });
    expect(result.current.revealedText).toBe('Bye');
  });

  it('cleans up rAF on unmount', () => {
    const { unmount } = renderHook(() =>
      useStreamingReveal('Hello world test', true, { charDelayMs: 50 })
    );

    unmount();
    // Should not throw
  });
});
