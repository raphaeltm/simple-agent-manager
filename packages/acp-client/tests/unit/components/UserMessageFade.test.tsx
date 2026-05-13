import { describe, expect, it, vi, afterEach } from 'vitest';
import { render } from '@testing-library/react';
import { UserMessageFade } from '../../../src/components/UserMessageFade';

describe('UserMessageFade', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('renders all characters in spans with char-fade class', () => {
    const { container } = render(<UserMessageFade text="Hello" />);
    const spans = container.querySelectorAll('.char-fade');
    expect(spans.length).toBe(5);
    const chars = Array.from(spans).map((s) => s.textContent).join('');
    expect(chars).toBe('Hello');
  });

  it('applies staggered animation-delay to each character', () => {
    const { container } = render(
      <UserMessageFade text="AB" baseCharDelayMs={20} fadeDurationMs={100} />
    );
    const spans = container.querySelectorAll('.char-fade');
    expect(spans.length).toBe(2);
    expect((spans[0] as HTMLElement).style.animationDelay).toBe('0ms');
    expect((spans[1] as HTMLElement).style.animationDelay).toBe('20ms');
  });

  it('uses adaptive timing for long messages', () => {
    // 100 chars with maxTotalMs=1500 → charDelay = 15ms (< baseCharDelayMs of 20)
    const text = 'x'.repeat(100);
    const { container } = render(
      <UserMessageFade text={text} baseCharDelayMs={20} maxTotalMs={1500} />
    );
    const spans = container.querySelectorAll('.char-fade');
    expect(spans.length).toBe(100);
    // Second char should have delay of 15ms (1500/100)
    expect((spans[1] as HTMLElement).style.animationDelay).toBe('15ms');
  });

  it('renders newlines as <br> elements', () => {
    const { container } = render(<UserMessageFade text={'line1\nline2'} />);
    const brs = container.querySelectorAll('br');
    expect(brs.length).toBe(1);
    // Total character spans should be 10 (5 + 5, excluding newline)
    const spans = container.querySelectorAll('.char-fade');
    expect(spans.length).toBe(10);
  });

  it('handles empty text', () => {
    const { container } = render(<UserMessageFade text="" />);
    const spans = container.querySelectorAll('.char-fade');
    expect(spans.length).toBe(0);
  });

  it('skips animation when prefers-reduced-motion is set', () => {
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
      const { container } = render(<UserMessageFade text="Hello" />);
      const spans = container.querySelectorAll('.char-fade');
      // With reduced motion, should NOT render char-fade spans
      expect(spans.length).toBe(0);
      // But should still render the text
      expect(container.textContent).toContain('Hello');
    } finally {
      window.matchMedia = original;
    }
  });

  it('sets animation-duration from fadeDurationMs prop', () => {
    const { container } = render(
      <UserMessageFade text="A" fadeDurationMs={200} />
    );
    const span = container.querySelector('.char-fade') as HTMLElement;
    expect(span.style.animationDuration).toBe('200ms');
  });
});
