import { memo, useCallback, useEffect, useRef } from 'react';
import type { Components } from 'react-markdown';
import Markdown from 'react-markdown';
import remarkGfm from 'remark-gfm';

import { useStreamingReveal } from '../hooks/useStreamingReveal';

export interface TypewriterTextProps {
  /** The full accumulated text to display. When this grows, new content is animated. */
  text: string;
  /** When false, renders all text instantly (use for historical messages). Default: true. */
  animated?: boolean;
  /** Milliseconds per character for the reveal. Default: 20. */
  charDelayMs?: number;
  /** Duration of the fade-in animation per character in ms. Default: 150. */
  fadeDurationMs?: number;
  /** Stagger between character fade starts in ms. Default: 8. */
  fadeStaggerMs?: number;
  /** Custom react-markdown component overrides (for code highlighting, file links, etc.). */
  markdownComponents?: Components;
}

// Stable remark plugins array
const REMARK_PLUGINS = [remarkGfm];

/**
 * Walk a DOM subtree and wrap the last `charCount` text characters in
 * `<span class="char-fade">` elements with staggered animation-delay.
 */
function applyCharFade(
  container: HTMLElement,
  charCount: number,
  fadeDurationMs: number,
  fadeStaggerMs: number
): void {
  if (charCount <= 0) return;

  // Collect all text nodes in document order
  const textNodes: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.length > 0) {
      textNodes.push(node);
    }
  }

  // Walk backwards through text nodes to find the last `charCount` characters
  let remaining = charCount;
  const targets: Array<{ node: Text; startIdx: number; count: number }> = [];

  for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i--) {
    const tn = textNodes[i]!;
    const len = tn.textContent!.length;
    const take = Math.min(len, remaining);
    targets.unshift({ node: tn, startIdx: len - take, count: take });
    remaining -= take;
  }

  // Wrap each character range in spans
  let spanIndex = 0;
  for (const { node: textNode, startIdx, count } of targets) {
    const parent = textNode.parentNode;
    if (!parent) continue;

    const fullText = textNode.textContent!;
    const frag = document.createDocumentFragment();

    // Text before the animated range
    if (startIdx > 0) {
      frag.appendChild(document.createTextNode(fullText.slice(0, startIdx)));
    }

    // Animated character spans
    for (let i = 0; i < count; i++) {
      const span = document.createElement('span');
      span.className = 'char-fade';
      span.style.animationDuration = `${fadeDurationMs}ms`;
      span.style.animationDelay = `${spanIndex * fadeStaggerMs}ms`;
      span.textContent = fullText[startIdx + i]!;
      frag.appendChild(span);
      spanIndex++;
    }

    // Text after the animated range
    if (startIdx + count < fullText.length) {
      frag.appendChild(document.createTextNode(fullText.slice(startIdx + count)));
    }

    parent.replaceChild(frag, textNode);
  }
}

/**
 * Remove all `.char-fade` spans, replacing them with their text content,
 * then normalize adjacent text nodes.
 */
function cleanupCharFade(container: HTMLElement): void {
  const spans = Array.from(container.querySelectorAll('.char-fade'));
  for (const span of spans) {
    const text = document.createTextNode(span.textContent || '');
    span.parentNode?.replaceChild(text, span);
  }
  container.normalize();
}

/**
 * TypewriterText — animates new text character-by-character with per-character CSS fade-in.
 *
 * Text is revealed one character at a time via `useStreamingReveal`, then rendered
 * through `react-markdown` for full markdown support. After each render, a DOM
 * TreeWalker wraps the newest characters in `<span class="char-fade">` elements
 * with staggered animation-delay. Spans are cleaned up after the animation completes.
 */
export const TypewriterText = memo(function TypewriterText({
  text,
  animated = true,
  charDelayMs = 20,
  fadeDurationMs = 150,
  fadeStaggerMs = 8,
  markdownComponents,
}: TypewriterTextProps) {
  const containerRef = useRef<HTMLDivElement>(null);
  const prevLengthRef = useRef(animated ? 0 : text.length);
  const cleanupTimerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  const { revealedText, isRevealing } = useStreamingReveal(text, animated, { charDelayMs });

  // After each render, apply char-fade to the new characters
  const applyFade = useCallback(() => {
    const container = containerRef.current;
    if (!container || !animated) return;

    const prevLen = prevLengthRef.current;
    const currentLen = revealedText.length;
    const delta = currentLen - prevLen;

    if (delta > 0) {
      // Clean up any existing spans before applying new ones
      cleanupCharFade(container);

      // Apply fade to the delta characters
      applyCharFade(container, delta, fadeDurationMs, fadeStaggerMs);

      // Schedule cleanup after animation completes
      if (cleanupTimerRef.current) {
        clearTimeout(cleanupTimerRef.current);
      }
      const totalAnimTime = delta * fadeStaggerMs + fadeDurationMs + 50;
      cleanupTimerRef.current = setTimeout(() => {
        if (containerRef.current) {
          cleanupCharFade(containerRef.current);
        }
      }, totalAnimTime);
    }

    prevLengthRef.current = currentLen;
  }, [revealedText, animated, fadeDurationMs, fadeStaggerMs]);

  // Apply fade effect after render
  useEffect(() => {
    applyFade();
  }, [applyFade]);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      if (cleanupTimerRef.current) {
        clearTimeout(cleanupTimerRef.current);
      }
    };
  }, []);

  return (
    <div ref={containerRef}>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {revealedText}
      </Markdown>
      {isRevealing && <span className="streaming-cursor" aria-hidden="true" />}
    </div>
  );
});
