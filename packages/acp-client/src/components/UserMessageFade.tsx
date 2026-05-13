import type { ReactNode } from 'react';
import { memo, useEffect, useMemo, useState } from 'react';

export interface UserMessageFadeProps {
  /** Plain text content of the user message. */
  text: string;
  /** Base delay per character in ms. Default: 20. */
  baseCharDelayMs?: number;
  /** Maximum total animation duration in ms. Default: 1500. */
  maxTotalMs?: number;
  /** Duration of the fade-in animation per character in ms. Default: 150. */
  fadeDurationMs?: number;
}

/** Subscribe to prefers-reduced-motion changes reactively. */
function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState(() =>
    typeof window !== 'undefined'
      ? window.matchMedia?.('(prefers-reduced-motion: reduce)').matches ?? false
      : false
  );

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const mql = window.matchMedia?.('(prefers-reduced-motion: reduce)');
    if (!mql) return;
    const handler = (e: MediaQueryListEvent) => setReduced(e.matches);
    mql.addEventListener('change', handler);
    return () => mql.removeEventListener('change', handler);
  }, []);

  return reduced;
}

/**
 * UserMessageFade — renders a user message with per-character fade-in animation.
 *
 * Each character is wrapped in a `<span class="char-fade">` with staggered
 * `animation-delay`. Timing is adaptive: short messages animate at `baseCharDelayMs`
 * pace, longer messages speed up so the total animation never exceeds `maxTotalMs`.
 *
 * User messages are plain text (no markdown), so spans are rendered directly.
 * Newlines become `<br>` elements between character spans.
 */
export const UserMessageFade = memo(function UserMessageFade({
  text,
  baseCharDelayMs = 20,
  maxTotalMs = 1500,
  fadeDurationMs = 150,
}: UserMessageFadeProps) {
  const prefersReducedMotion = usePrefersReducedMotion();

  const elements = useMemo<ReactNode[]>(() => {
    if (prefersReducedMotion || text.length === 0) {
      // No animation — render plain text with line breaks
      return text.split('\n').flatMap((line, lineIdx, lines) => {
        const result: ReactNode[] = [<span key={`line-${lineIdx}`}>{line}</span>];
        if (lineIdx < lines.length - 1) {
          result.push(<br key={`br-${lineIdx}`} />);
        }
        return result;
      });
    }

    const charDelayMs = Math.min(maxTotalMs / text.length, baseCharDelayMs);
    const nodes: ReactNode[] = [];
    let charIndex = 0;

    // Use Array.from to handle surrogate pairs (emoji) correctly
    const chars = Array.from(text);
    for (let i = 0; i < chars.length; i++) {
      const ch = chars[i]!;
      if (ch === '\n') {
        nodes.push(<br key={`br-${i}`} />);
      } else {
        nodes.push(
          <span
            key={`ch-${i}`}
            className="char-fade"
            aria-hidden="true"
            style={{
              animationDuration: `${fadeDurationMs}ms`,
              animationDelay: `${charIndex * charDelayMs}ms`,
            }}
          >
            {ch}
          </span>
        );
        charIndex++;
      }
    }

    return nodes;
  }, [text, baseCharDelayMs, maxTotalMs, fadeDurationMs, prefersReducedMotion]);

  return (
    <span aria-label={text}>
      {elements}
    </span>
  );
});
