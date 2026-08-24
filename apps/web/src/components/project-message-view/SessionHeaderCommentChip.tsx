import { MessageSquareQuote } from 'lucide-react';

export function SessionHeaderCommentChip({
  unresolvedCommentCount,
  needsAttentionCommentCount,
  onOpenComments,
}: {
  unresolvedCommentCount: number;
  needsAttentionCommentCount: number;
  onOpenComments: () => void;
}) {
  if (unresolvedCommentCount <= 0) return null;

  return (
    <button
      type="button"
      onClick={onOpenComments}
      className="inline-flex items-center gap-1 text-[10px] font-medium px-1.5 py-0.5 rounded shrink-0 border cursor-pointer whitespace-nowrap transition-colors hover:bg-surface-hover focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-accent-primary"
      style={{
        color:
          needsAttentionCommentCount > 0
            ? 'var(--sam-color-warning-fg)'
            : 'var(--sam-color-fg-muted)',
        borderColor:
          needsAttentionCommentCount > 0
            ? 'var(--sam-color-warning)'
            : 'var(--sam-color-border-default)',
        backgroundColor:
          needsAttentionCommentCount > 0 ? 'var(--sam-color-warning-tint)' : 'transparent',
      }}
      aria-label={`${unresolvedCommentCount} unresolved ${unresolvedCommentCount === 1 ? 'comment' : 'comments'}${
        needsAttentionCommentCount > 0 ? `, ${needsAttentionCommentCount} needing your attention` : ''
      }`}
      title="Open comments"
    >
      <MessageSquareQuote size={10} aria-hidden="true" />
      {/*
        Lead with the actionable number. "5 needs you" would be a lie — 5 is
        the unresolved total and only 3 of those are waiting on the reader.
        When nothing is waiting, the total is the useful figure.
      */}
      {needsAttentionCommentCount > 0
        ? `${needsAttentionCommentCount} need${needsAttentionCommentCount === 1 ? 's' : ''} you`
        : unresolvedCommentCount}
    </button>
  );
}
