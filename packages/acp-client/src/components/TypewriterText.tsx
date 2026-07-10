import { memo } from 'react';
import type { Components } from 'react-markdown';
import Markdown from 'react-markdown';

import { useStreamingReveal } from '../hooks/useStreamingReveal';
import { REMARK_PLUGINS } from './markdown-config';

export interface TypewriterTextProps {
  /** The full accumulated text to display. When this grows, new content is animated. */
  text: string;
  /** When false, renders all text instantly (use for historical messages). Default: true. */
  animated?: boolean;
  /** Milliseconds per character for the reveal. Default: 10. */
  charDelayMs?: number;
  /** Custom react-markdown component overrides (for code highlighting, file links, etc.). */
  markdownComponents?: Components;
}

/**
 * TypewriterText — animates new text character-by-character.
 *
 * Text is revealed one character at a time via `useStreamingReveal`, then rendered
 * through `react-markdown` for full markdown support. The character-by-character
 * reveal itself IS the animation — no imperative DOM manipulation is used, so
 * React's reconciler always owns the DOM tree.
 */
export const TypewriterText = memo(function TypewriterText({
  text,
  animated = true,
  charDelayMs = 10,
  markdownComponents,
}: TypewriterTextProps) {
  const { revealedText, isRevealing } = useStreamingReveal(text, animated, { charDelayMs });

  return (
    <div>
      <Markdown remarkPlugins={REMARK_PLUGINS} components={markdownComponents}>
        {revealedText}
      </Markdown>
      {isRevealing && <span className="streaming-cursor" aria-hidden="true" />}
    </div>
  );
});
