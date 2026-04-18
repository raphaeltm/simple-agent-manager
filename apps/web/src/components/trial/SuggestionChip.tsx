/**
 * SuggestionChip — pill button that fills the chat textarea with an idea prompt.
 *
 * Used inside {@link ChatGate}. One chip per `trial.idea` SSE event.
 *
 * Accessibility:
 * - `aria-label` exposes the full title + summary (sighted users see truncated
 *   text but assistive tech gets the whole thing).
 * - Minimum 44×44 touch target per rule 17.
 * - Focus ring uses the design-system focus utility classes.
 */
import type { TrialIdea } from '@simple-agent-manager/shared';

interface SuggestionChipProps {
  idea: TrialIdea;
  onSelect: (idea: TrialIdea) => void;
  disabled?: boolean;
}

export function SuggestionChip({ idea, onSelect, disabled = false }: SuggestionChipProps) {
  return (
    <button
      type="button"
      onClick={() => onSelect(idea)}
      disabled={disabled}
      aria-label={`${idea.title} — ${idea.summary}`}
      title={`${idea.title} — ${idea.summary}`}
      data-testid={`suggestion-chip-${idea.id}`}
      className="
        flex-shrink-0 inline-flex flex-col items-start gap-0.5
        min-h-11 px-4 py-2 rounded-full
        border border-border-default bg-surface
        text-left text-fg-primary
        hover:border-accent hover:bg-surface-hover
        focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent
        disabled:opacity-50 disabled:cursor-not-allowed
        transition-colors duration-150
        max-w-[260px]
      "
    >
      <span className="text-sm font-medium truncate max-w-full">{idea.title}</span>
      <span className="text-xs text-fg-muted truncate max-w-full">
        {idea.summary}
      </span>
    </button>
  );
}
