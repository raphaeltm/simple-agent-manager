import { useEffect, useRef, useState } from 'react';

export interface UseStreamingRevealOptions {
  /** Milliseconds per character reveal. Default: 20. */
  charDelayMs?: number;
}

/**
 * useStreamingReveal — smooths chunky batch text arrivals into character-by-character reveal.
 *
 * Accepts `fullText` (the complete buffered text so far) and returns `revealedText`
 * which grows one character at a time via requestAnimationFrame. When `fullText` grows
 * (new batch arrives), the buffer extends but reveal continues at its steady pace.
 *
 * Returns `{ revealedText, isRevealing, prevRevealedLength }` where `prevRevealedLength`
 * is the character count from the previous render cycle (for computing the fade delta).
 */
export function useStreamingReveal(
  fullText: string,
  animated: boolean,
  options: UseStreamingRevealOptions = {}
): { revealedText: string; isRevealing: boolean; prevRevealedLength: number } {
  const { charDelayMs = 20 } = options;

  const [revealIndex, setRevealIndex] = useState(animated ? 0 : fullText.length);
  const prevRevealedLengthRef = useRef(animated ? 0 : fullText.length);
  const rafIdRef = useRef(0);
  const lastTickRef = useRef(0);
  const charDelayRef = useRef(charDelayMs);
  charDelayRef.current = charDelayMs;

  // Track the target length for the rAF loop
  const targetLengthRef = useRef(fullText.length);
  targetLengthRef.current = fullText.length;

  // Respect prefers-reduced-motion
  const prefersReducedMotion =
    typeof window !== 'undefined' &&
    window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const shouldAnimate = animated && !prefersReducedMotion;

  useEffect(() => {
    if (!shouldAnimate) {
      prevRevealedLengthRef.current = revealIndex;
      setRevealIndex(fullText.length);
      return;
    }

    // If text shrunk or was replaced, snap to the new text
    if (fullText.length < revealIndex) {
      prevRevealedLengthRef.current = 0;
      setRevealIndex(fullText.length);
      return;
    }

    // Already fully revealed — nothing to do
    if (revealIndex >= fullText.length) return;

    // Start the reveal loop if not already running
    if (rafIdRef.current === 0) {
      lastTickRef.current = performance.now();

      const tick = (now: number) => {
        const elapsed = now - lastTickRef.current;
        const charsToReveal = Math.floor(elapsed / charDelayRef.current);

        if (charsToReveal > 0) {
          lastTickRef.current = now;
          setRevealIndex((prev) => {
            const next = Math.min(prev + charsToReveal, targetLengthRef.current);
            return next;
          });
        }

        // Continue if there's more to reveal
        rafIdRef.current = requestAnimationFrame(tick);
      };

      rafIdRef.current = requestAnimationFrame(tick);
    }

    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fullText, shouldAnimate]);

  // Stop the loop once fully revealed
  useEffect(() => {
    if (revealIndex >= fullText.length && rafIdRef.current) {
      cancelAnimationFrame(rafIdRef.current);
      rafIdRef.current = 0;
    }
  }, [revealIndex, fullText.length]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
        rafIdRef.current = 0;
      }
    };
  }, []);

  const isRevealing = shouldAnimate && revealIndex < fullText.length;
  const revealedText = shouldAnimate ? fullText.slice(0, revealIndex) : fullText;
  const prevRevealedLength = prevRevealedLengthRef.current;

  // Update the prev ref for next render
  if (revealIndex !== prevRevealedLengthRef.current) {
    prevRevealedLengthRef.current = revealIndex;
  }

  return { revealedText, isRevealing, prevRevealedLength };
}
