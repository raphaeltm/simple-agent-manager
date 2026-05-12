import { memo, useEffect, useRef, useState } from 'react';

export interface TypewriterTextProps {
  /** The full accumulated text to display. When this grows, new content is animated. */
  text: string;
  /** When false, renders all text instantly (use for historical messages). Default: true. */
  animated?: boolean;
  /** Target words per second for the animation. Default: 25. */
  wordsPerSecond?: number;
  /** Expected interval between batches in ms (for adaptive rate). Default: 2000. */
  batchIntervalMs?: number;
}

/** Split text into words preserving whitespace for markdown safety. */
function splitWords(text: string): string[] {
  const result: string[] = [];
  const regex = /\S+\s*/g;
  let match: RegExpExecArray | null;
  while ((match = regex.exec(text)) !== null) {
    result.push(match[0]);
  }
  // Preserve leading whitespace
  const leadingWs = text.match(/^\s+/);
  if (leadingWs && result.length > 0) {
    result[0] = leadingWs[0] + result[0];
  } else if (leadingWs && result.length === 0) {
    result.push(leadingWs[0]);
  }
  return result;
}

/**
 * TypewriterText — animates new text additions word-by-word.
 *
 * When the `text` prop grows (new batch arrives), the new content is queued
 * and revealed word-by-word using requestAnimationFrame. When the queue
 * empties, animation stops naturally — correctly signaling "agent is thinking."
 *
 * Adaptive rate: adjusts speed based on queue size relative to expected batch interval.
 */
export const TypewriterText = memo(function TypewriterText({
  text,
  animated = true,
  wordsPerSecond = 25,
  batchIntervalMs = 2000,
}: TypewriterTextProps) {
  const [displayedText, setDisplayedText] = useState(animated ? '' : text);
  const queueRef = useRef<string[]>([]);
  const animatingRef = useRef(false);
  const prevTextRef = useRef(animated ? '' : text);
  const rafIdRef = useRef<number>(0);
  const lastFrameTimeRef = useRef(0);
  const wpsRef = useRef(wordsPerSecond);
  const batchMsRef = useRef(batchIntervalMs);
  wpsRef.current = wordsPerSecond;
  batchMsRef.current = batchIntervalMs;

  // Animation frame callback (stable ref to avoid stale closures)
  const tick = useRef<(time: number) => void>(() => {});
  tick.current = (time: number) => {
    const queue = queueRef.current;
    if (queue.length === 0) {
      animatingRef.current = false;
      return;
    }

    const elapsed = time - lastFrameTimeRef.current;
    // Adaptive rate: scale wps based on queue size
    const adaptiveWps = Math.max(
      wpsRef.current,
      (queue.length / batchMsRef.current) * 1000
    );
    const msPerWord = 1000 / adaptiveWps;

    if (elapsed >= msPerWord) {
      const wordsToReveal = Math.max(1, Math.floor(elapsed / msPerWord));
      const revealed = queue.splice(0, wordsToReveal);
      setDisplayedText((prev) => prev + revealed.join(''));
      lastFrameTimeRef.current = time;
    }

    if (queue.length > 0) {
      rafIdRef.current = requestAnimationFrame(runTick);
    } else {
      animatingRef.current = false;
    }
  };

  function runTick(time: number) {
    tick.current(time);
  }

  // Respect prefers-reduced-motion (WCAG 2.1 SC 2.3.3)
  const prefersReducedMotion = typeof window !== 'undefined'
    && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches;
  const shouldAnimate = animated && !prefersReducedMotion;

  // Detect new text and queue for animation (or show instantly if not animated)
  useEffect(() => {
    if (!shouldAnimate) {
      setDisplayedText(text);
      queueRef.current = [];
      prevTextRef.current = text;
      return;
    }

    const prev = prevTextRef.current;
    prevTextRef.current = text;

    if (text.length <= prev.length) {
      // Text didn't grow — replacement or reset. Show it all.
      if (text !== prev) {
        queueRef.current = [];
        setDisplayedText(text);
      }
      return;
    }

    // New content is the delta
    const newContent = text.slice(prev.length);
    const newWords = splitWords(newContent);
    if (newWords.length === 0) return;

    queueRef.current.push(...newWords);

    if (!animatingRef.current) {
      animatingRef.current = true;
      lastFrameTimeRef.current = performance.now();
      rafIdRef.current = requestAnimationFrame(runTick);
    }
  }, [text, shouldAnimate]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (rafIdRef.current) {
        cancelAnimationFrame(rafIdRef.current);
      }
    };
  }, []);

  return <>{displayedText}</>;
});
