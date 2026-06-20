import { useEffect, useRef, useState } from 'react';

import { usePrefersReducedMotion } from './usePrefersReducedMotion';

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
 * Returns `{ revealedText, isRevealing }`.
 */
export function useStreamingReveal(
  fullText: string,
  animated: boolean,
  options: UseStreamingRevealOptions = {}
): { revealedText: string; isRevealing: boolean } {
  const { charDelayMs = 20 } = options;

  const [revealIndex, setRevealIndex] = useState(animated ? 0 : fullText.length);
  const rafIdRef = useRef(0);
  const lastTickRef = useRef(0);
  const charDelayRef = useRef(charDelayMs);
  charDelayRef.current = charDelayMs;

  // Track the target length for the rAF loop
  const targetLengthRef = useRef(fullText.length);
  targetLengthRef.current = fullText.length;

  // Keep a ref copy of revealIndex so the rAF-start effect can read it
  // without depending on it (avoids restarting the loop on every tick).
  const revealIndexRef = useRef(revealIndex);
  revealIndexRef.current = revealIndex;

  // Respect prefers-reduced-motion (reactive)
  const prefersReducedMotion = usePrefersReducedMotion();
  const shouldAnimate = animated && !prefersReducedMotion;

  // Snap revealIndex when animation is disabled or text shrinks
  useEffect(() => {
    if (!shouldAnimate) {
      setRevealIndex(fullText.length);
      return;
    }

    // If text shrunk or was replaced, snap to the new text
    if (fullText.length < revealIndexRef.current) {
      setRevealIndex(fullText.length);
      return;
    }

    // Already fully revealed — nothing to do
    if (revealIndexRef.current >= fullText.length) return;

    // Start the reveal loop if not already running
    if (rafIdRef.current === 0) {
      lastTickRef.current = performance.now();

      const tick = (now: number) => {
        const elapsed = now - lastTickRef.current;
        const charsToReveal = Math.floor(elapsed / charDelayRef.current);

        if (charsToReveal > 0) {
          lastTickRef.current = now;
          let done = false;
          setRevealIndex((prev) => {
            const next = Math.min(prev + charsToReveal, targetLengthRef.current);
            done = next >= targetLengthRef.current;
            return next;
          });
          if (done) {
            rafIdRef.current = 0;
            return;
          }
        }

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

  return { revealedText, isRevealing };
}
