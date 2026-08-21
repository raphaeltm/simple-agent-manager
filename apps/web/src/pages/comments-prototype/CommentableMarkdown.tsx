/**
 * The markdown-file surface.
 *
 * Rendering goes through the production `RenderedMarkdown` (react-markdown +
 * remark-gfm + the app's component overrides), one call per top-level block, so
 * each block gets a stable `data-comment-anchor` id and its own gutter marker.
 *
 * Why per-block instead of one call for the whole document: block-level anchoring
 * requires block segmentation regardless, and `RenderedMarkdown` builds its
 * `components` map from inline literals with no injection point. Segmenting here
 * keeps the real renderer intact rather than forking it. A production version
 * would lift that map out and pass anchors through it instead.
 */

import { useMemo } from 'react';

import { RenderedMarkdown } from '../../components/MarkdownRenderer';
import type { Comment } from './comment-types';
import { commentsForBlock } from './comment-types';
import { CommentCountMarker, CommentGlyph } from './CommentPrimitives';
import { CommentThreadList } from './CommentThread';

/**
 * Split markdown into top-level blocks on blank lines, keeping fenced code blocks
 * and contiguous table rows intact.
 */
export function splitMarkdownBlocks(source: string): { id: string; markdown: string }[] {
  const lines = source.split('\n');
  const blocks: string[] = [];
  let current: string[] = [];
  let inFence = false;

  const flush = () => {
    const text = current.join('\n').trim();
    if (text) blocks.push(text);
    current = [];
  };

  for (const line of lines) {
    // ``` or ~~~ toggles a fence. Inside a fence, blank lines are content.
    if (/^\s*(```|~~~)/.test(line)) {
      inFence = !inFence;
      current.push(line);
      if (!inFence) flush();
      continue;
    }
    if (!inFence && line.trim() === '') {
      flush();
      continue;
    }
    current.push(line);
  }
  flush();

  return blocks.map((markdown, i) => ({ id: `block-${i}`, markdown }));
}

export interface CommentableMarkdownProps {
  path: string;
  source: string;
  comments: Comment[];
  now: number;
  inlineThreads: boolean;
  /**
   * Narrow viewports drop the left gutter entirely. With no hover, every block's
   * "add a comment" glyph had to render permanently, which put an icon column
   * down the left of the whole document and ate 24px of a 375px screen for an
   * affordance that is almost never the one you want. On touch, selecting text is
   * the natural way to comment on prose anyway.
   */
  compact: boolean;
  openAnchorId: string | null;
  onOpenAnchor: (anchorId: string | null) => void;
  onStartComment: (anchorId: string, quote?: string) => void;
  onReply: (commentId: string, body: string, sendToAgent: boolean) => void;
  onToggleResolved: (commentId: string) => void;
  renderComposer: (anchorId: string) => React.ReactNode;
}

export function CommentableMarkdown({
  path,
  source,
  comments,
  now,
  inlineThreads,
  compact,
  openAnchorId,
  onOpenAnchor,
  onStartComment,
  onReply,
  onToggleResolved,
  renderComposer,
}: CommentableMarkdownProps) {
  const blocks = useMemo(() => splitMarkdownBlocks(source), [source]);

  return (
    <div className="min-w-0">
      <header
        className="mb-3 flex items-center gap-2 border-b pb-2 font-mono text-xs"
        style={{
          borderColor: 'var(--sam-color-border-default, #29423b)',
          color: 'var(--sam-color-fg-muted, #9fb7ae)',
          overflowWrap: 'anywhere',
        }}
      >
        {path}
      </header>

      <div className="flex flex-col">
        {blocks.map((block) => {
          const mine = commentsForBlock(comments, block.id);
          const unresolved = mine.filter((c) => c.status !== 'resolved');
          const isOpen = openAnchorId === block.id;

          return (
            <div
              key={block.id}
              className="group relative min-w-0"
              data-testid={`md-row-${block.id}`}
            >
              {/* Compact: the marker rides above the block instead of beside it,
                  so prose keeps the full width and uncommented blocks cost nothing. */}
              {compact && mine.length > 0 && (
                <div className="mb-1 flex">
                  <CommentCountMarker
                    count={mine.length}
                    hasUnresolved={unresolved.length > 0}
                    onClick={() => onOpenAnchor(isOpen ? null : block.id)}
                    label={`${mine.length} comment${mine.length === 1 ? '' : 's'} on this block`}
                  />
                </div>
              )}

              <div className="flex min-w-0 items-start gap-1.5">
                {/* Gutter. Fixed width so prose left-edges stay aligned whether or
                    not a block has comments. Wide viewports only — see `compact`. */}
                {!compact && (
                  <div className="flex w-6 shrink-0 flex-col items-center pt-3">
                    {mine.length > 0 ? (
                      <CommentCountMarker
                        count={mine.length}
                        hasUnresolved={unresolved.length > 0}
                        onClick={() => onOpenAnchor(isOpen ? null : block.id)}
                        label={`${mine.length} comment${mine.length === 1 ? '' : 's'} on this block`}
                      />
                    ) : (
                      <button
                        type="button"
                        onClick={() => onStartComment(block.id)}
                        aria-label="Add a comment on this block"
                        className="rounded p-1 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 focus-visible:outline focus-visible:outline-2"
                        style={{
                          color: 'var(--sam-color-fg-muted, #9fb7ae)',
                          outlineColor: 'var(--sam-color-focus-ring, #34d399)',
                        }}
                      >
                        <CommentGlyph size={14} />
                      </button>
                    )}
                  </div>
                )}

                <div
                  data-comment-anchor={block.id}
                  data-testid={`md-${block.id}`}
                  className="min-w-0 flex-1 rounded"
                  style={{
                    backgroundColor:
                      unresolved.length > 0
                        ? 'var(--sam-color-warning-tint, rgba(245,158,11,0.1))'
                        : undefined,
                    // A highlighted block needs breathing room from the tint edge.
                    padding: unresolved.length > 0 ? '0 6px' : undefined,
                  }}
                >
                  <RenderedMarkdown content={block.markdown} inline />
                </div>
              </div>

              {inlineThreads && isOpen && mine.length > 0 && (
                <div className={`mb-3 flex flex-col gap-3 ${compact ? '' : 'ml-7'}`}>
                  <CommentThreadList
                    comments={mine}
                    now={now}
                    onReply={onReply}
                    onToggleResolved={onToggleResolved}
                  />
                </div>
              )}

              <div className={compact ? '' : 'ml-7'}>{renderComposer(block.id)}</div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
