import { describe, expect, it, vi, beforeEach, afterEach } from 'vitest';
import { renderHook, act } from '@testing-library/react';
import { useStreamingReveal } from '../../../src/hooks/useStreamingReveal';
import { setupRafMock, type RafMockState } from '../helpers/raf-mock';

describe('useStreamingReveal', () => {
  let raf: RafMockState;

  beforeEach(() => {
    raf = setupRafMock();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

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

    act(() => { raf.advanceTime(25); });
    // After 25ms at 10ms/char, should have revealed ~2 chars
    expect(result.current.revealedText.length).toBeGreaterThanOrEqual(2);

    act(() => { raf.advanceTime(100); });
    expect(result.current.revealedText).toBe('Hello');
    expect(result.current.isRevealing).toBe(false);
  });

  it('stops rAF loop after full reveal', () => {
    renderHook(() =>
      useStreamingReveal('Hi', true, { charDelayMs: 10 })
    );

    act(() => { raf.advanceTime(100); });
    // After full reveal, no more rAF callbacks should be queued
    expect(raf.rafQueue.length).toBe(0);
  });

  it('extends reveal when text grows', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingReveal(text, true, { charDelayMs: 10 }),
      { initialProps: { text: 'Hi' } }
    );

    act(() => { raf.advanceTime(100); });
    expect(result.current.revealedText).toBe('Hi');

    rerender({ text: 'Hi there' });

    act(() => { raf.advanceTime(200); });
    expect(result.current.revealedText).toBe('Hi there');
  });

  it('snaps to new text on replacement (shrink)', () => {
    const { result, rerender } = renderHook(
      ({ text }) => useStreamingReveal(text, true, { charDelayMs: 10 }),
      { initialProps: { text: 'Hello' } }
    );

    act(() => { raf.advanceTime(200); });
    expect(result.current.revealedText).toBe('Hello');

    rerender({ text: 'Bye' });
    expect(result.current.revealedText).toBe('Bye');
  });

  it('returns full text immediately when prefers-reduced-motion is set', () => {
    const original = window.matchMedia;
    window.matchMedia = ((query: string) => ({
      matches: query === '(prefers-reduced-motion: reduce)',
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => false,
    })) as typeof window.matchMedia;

    try {
      const { result } = renderHook(() =>
        useStreamingReveal('Hello', true, { charDelayMs: 10 })
      );
      expect(result.current.revealedText).toBe('Hello');
      expect(result.current.isRevealing).toBe(false);
      // No rAF should be queued
      expect(raf.rafQueue.length).toBe(0);
    } finally {
      window.matchMedia = original;
    }
  });

  it('handles empty text with animated=true', () => {
    const { result } = renderHook(() =>
      useStreamingReveal('', true, { charDelayMs: 10 })
    );
    expect(result.current.revealedText).toBe('');
    expect(result.current.isRevealing).toBe(false);
    // No rAF should be queued for empty text
    expect(raf.rafQueue.length).toBe(0);
  });

  it('cleans up rAF on unmount', () => {
    const cancelSpy = vi.spyOn(window, 'cancelAnimationFrame');
    const { unmount } = renderHook(() =>
      useStreamingReveal('Hello world test', true, { charDelayMs: 50 })
    );

    unmount();
    expect(cancelSpy).toHaveBeenCalled();
  });
});
