import { MessageSquareQuote } from 'lucide-react';

/**
 * Always-visible comment discovery chip.
 *
 * This intentionally lives outside the collapsed action row: comments are a
 * discovery surface, so the affordance must be visible before the user already
 * knows there is something to find.
 */
export function SessionCommentChip({
  unresolvedCommentCount,
  needsAttentionCommentCount,
  onOpenComments,
}: Readonly<{
  unresolvedCommentCount: number;
  needsAttentionCommentCount: number;
  onOpenComments: () => void;
}>) {
  const hasAttention = needsAttentionCommentCount > 0;
  const commentNoun = unresolvedCommentCount === 1 ? 'comment' : 'comments';
  const attentionSuffix = hasAttention
    ? `, ${needsAttentionCommentCount} needing your attention`
    : '';
  const ariaLabel =
    unresolvedCommentCount > 0
      ? `${unresolvedCommentCount} unresolved ${commentNoun}${attentionSuffix}`
      : 'Comments';
  const attentionVerb = needsAttentionCommentCount === 1 ? 'needs' : 'need';
  const chipText =
    unresolvedCommentCount <= 0
      ? 'Comments'
      : hasAttention
        ? `${needsAttentionCommentCount} ${attentionVerb} you`
        : String(unresolvedCommentCount);

  return (
    <button
      type="button"
      onClick={onOpenComments}
      className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 border cursor-pointer whitespace-nowrap transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
      style={{
        color: hasAttention ? 'var(--sam-color-warning-fg)' : 'var(--sam-color-fg-muted)',
        borderColor: hasAttention ? 'var(--sam-color-warning)' : 'var(--sam-color-border-default)',
        backgroundColor: hasAttention ? 'var(--sam-color-warning-tint)' : 'transparent',
      }}
      aria-label={ariaLabel}
      title="Open comments"
    >
      <MessageSquareQuote size={10} aria-hidden="true" />
      {chipText}
    </button>
  );
}
