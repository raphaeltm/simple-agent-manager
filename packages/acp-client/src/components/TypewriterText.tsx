import { memo, useCallback, useEffect, useRef } from 'react';
import type { Components } from 'react-markdown';
import Markdown from 'react-markdown';

import { useStreamingReveal } from '../hooks/useStreamingReveal';
import { REMARK_PLUGINS } from './markdown-config';

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

/** Collect all non-empty text nodes from a container in document order. */
function collectTextNodes(container: HTMLElement): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  let node: Text | null;
  while ((node = walker.nextNode() as Text | null)) {
    if (node.textContent && node.textContent.length > 0) {
      nodes.push(node);
    }
  }
  return nodes;
}

/** Find the last `charCount` characters across text nodes, walking backwards. */
function findCharTargets(
  textNodes: Text[],
  charCount: number
): Array<{ node: Text; startIdx: number; count: number }> {
  let remaining = charCount;
  const targets: Array<{ node: Text; startIdx: number; count: number }> = [];
  for (let i = textNodes.length - 1; i >= 0 && remaining > 0; i--) {
    const tn = textNodes[i]!;
    const len = tn.textContent!.length;
    const take = Math.min(len, remaining);
    targets.unshift({ node: tn, startIdx: len - take, count: take });
    remaining -= take;
  }
  return targets;
}

/** Replace a text node with a fragment containing char-fade spans. */
function wrapTextNodeChars(
  textNode: Text,
  startIdx: number,
  count: number,
  baseSpanIndex: number,
  fadeDurationMs: number,
  fadeStaggerMs: number
): number {
  const parent = textNode.parentNode;
  if (!parent) return baseSpanIndex;

  const fullText = textNode.textContent!;
  const frag = document.createDocumentFragment();

  if (startIdx > 0) {
    frag.appendChild(document.createTextNode(fullText.slice(0, startIdx)));
  }

  let spanIndex = baseSpanIndex;
  for (let i = 0; i < count; i++) {
    const span = document.createElement('span');
    span.className = 'char-fade';
    span.style.animationDuration = `${fadeDurationMs}ms`;
    span.style.animationDelay = `${spanIndex * fadeStaggerMs}ms`;
    span.textContent = fullText[startIdx + i]!;
    frag.appendChild(span);
    spanIndex++;
  }

  if (startIdx + count < fullText.length) {
    frag.appendChild(document.createTextNode(fullText.slice(startIdx + count)));
  }

  parent.replaceChild(frag, textNode);
  return spanIndex;
}

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
  const textNodes = collectTextNodes(container);
  const targets = findCharTargets(textNodes, charCount);
  let spanIndex = 0;
  for (const { node, startIdx, count } of targets) {
    spanIndex = wrapTextNodeChars(node, startIdx, count, spanIndex, fadeDurationMs, fadeStaggerMs);
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
