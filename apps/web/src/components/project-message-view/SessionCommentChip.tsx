import { chipClassName } from '@simple-agent-manager/ui';
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
      // Amber only when someone is waiting on you; otherwise a neutral chip (SAM Glass).
      className={`${chipClassName({ tone: hasAttention ? 'warning' : 'neutral' })} cursor-pointer transition-[filter] hover:brightness-110 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring`}
      aria-label={ariaLabel}
      title="Open comments"
    >
      <MessageSquareQuote size={14} strokeWidth={1.75} aria-hidden="true" />
      {chipText}
    </button>
  );
}
