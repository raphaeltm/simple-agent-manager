/**
 * Commenting prototype — comment on agent messages and markdown files.
 *
 * PROTOTYPE ONLY. Registered behind `devOnlyRoutesEnabled()` in App.tsx, so it
 * cannot reach a production build. No API calls, no auth, mock data only.
 * See `.claude/rules/37-prototype-development.md`.
 *
 * What it demonstrates:
 *  1. One thread UI serving two very different surfaces (chat + markdown doc).
 *  2. Two anchor granularities: whole-object and text-selection.
 *  3. A comment that can become an agent instruction ("send to agent") — the
 *     SAM-specific move that makes this more than a notes feature.
 */

import { Button } from '@simple-agent-manager/ui';
import { useCallback, useEffect, useMemo, useState } from 'react';

import type { Comment, CommentAnchor, CommentStatus } from './comment-types';
import { CommentableChat } from './CommentableChat';
import { CommentableMarkdown } from './CommentableMarkdown';
import {
  CommentComposer,
  CommentGlyph,
  SelectionActionBar,
  SelectionPopover,
} from './CommentPrimitives';
import { CommentThreadList } from './CommentThread';
import {
  AGENT,
  INITIAL_COMMENTS,
  MANY_COMMENTS,
  MARKDOWN_DOC,
  MARKDOWN_PATH,
  MESSAGES,
  NO_COMMENTS,
  NOW,
  RAPHAEL,
} from './mock-data';
import { useCoarsePointer, useCommentSelection } from './useCommentSelection';

type Surface = 'chat' | 'file';
type Dataset = 'default' | 'empty' | 'many';
type Filter = 'all' | 'open' | 'resolved';

const DESKTOP_RAIL_MIN_WIDTH = 1024;

let nextId = 1000;
function makeId(prefix: string) {
  return `${prefix}-${nextId++}`;
}

export function CommentsPrototype() {
  const [surface, setSurface] = useState<Surface>('chat');
  const [dataset, setDataset] = useState<Dataset>('default');
  const [filter, setFilter] = useState<Filter>('all');
  const [comments, setComments] = useState<Comment[]>(INITIAL_COMMENTS);
  const [openAnchorId, setOpenAnchorId] = useState<string | null>(null);
  const [composingAnchor, setComposingAnchor] = useState<{
    anchorId: string;
    quote?: string;
  } | null>(null);
  const [isWide, setIsWide] = useState(false);

  // Rail vs. inline threads is a layout decision, so it keys off viewport width
  // rather than a user-agent guess.
  useEffect(() => {
    const mq = window.matchMedia(`(min-width: ${DESKTOP_RAIL_MIN_WIDTH}px)`);
    const sync = () => setIsWide(mq.matches);
    sync();
    mq.addEventListener('change', sync);
    return () => mq.removeEventListener('change', sync);
  }, []);

  useEffect(() => {
    setComments(
      dataset === 'empty' ? NO_COMMENTS : dataset === 'many' ? MANY_COMMENTS : INITIAL_COMMENTS
    );
    setOpenAnchorId(null);
    setComposingAnchor(null);
  }, [dataset]);

  const { selection, clear: clearSelection } = useCommentSelection(true);
  const coarsePointer = useCoarsePointer();

  const startComment = useCallback((anchorId: string, quote?: string) => {
    setComposingAnchor({ anchorId, quote });
    setOpenAnchorId(anchorId);
  }, []);

  const addComment = useCallback(
    (anchorId: string, quote: string | undefined, body: string, sendToAgent: boolean) => {
      const anchor: CommentAnchor =
        surface === 'chat'
          ? { kind: 'message', messageId: anchorId, quote }
          : { kind: 'file', path: MARKDOWN_PATH, blockId: anchorId, quote };

      const created: Comment = {
        id: makeId('c'),
        anchor,
        author: RAPHAEL,
        body,
        createdAt: Date.now(),
        status: sendToAgent ? 'sent' : 'open',
        replies: sendToAgent
          ? [
              {
                id: makeId('r'),
                author: AGENT,
                body: 'Picked this up — starting a follow-up turn with the quoted context attached.',
                createdAt: Date.now() + 1000,
              },
            ]
          : [],
      };
      setComments((prev) => [...prev, created]);
      setComposingAnchor(null);
      setOpenAnchorId(anchorId);
    },
    [surface]
  );

  const handleReply = useCallback((commentId: string, body: string, sendToAgent: boolean) => {
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? {
              ...c,
              status: sendToAgent ? ('sent' as CommentStatus) : c.status,
              replies: [
                ...c.replies,
                { id: makeId('r'), author: RAPHAEL, body, createdAt: Date.now() },
              ],
            }
          : c
      )
    );
  }, []);

  const handleToggleResolved = useCallback((commentId: string) => {
    setComments((prev) =>
      prev.map((c) =>
        c.id === commentId
          ? { ...c, status: c.status === 'resolved' ? 'open' : ('resolved' as CommentStatus) }
          : c
      )
    );
  }, []);

  // Only comments belonging to the visible surface.
  const surfaceComments = useMemo(
    () =>
      comments.filter((c) =>
        surface === 'chat' ? c.anchor.kind === 'message' : c.anchor.kind === 'file'
      ),
    [comments, surface]
  );

  const filteredForRail = useMemo(() => {
    if (filter === 'open') return surfaceComments.filter((c) => c.status !== 'resolved');
    if (filter === 'resolved') return surfaceComments.filter((c) => c.status === 'resolved');
    return surfaceComments;
  }, [surfaceComments, filter]);

  const openCount = surfaceComments.filter((c) => c.status !== 'resolved').length;

  const renderComposer = useCallback(
    (anchorId: string) =>
      composingAnchor?.anchorId === anchorId ? (
        <div
          className="mb-4 rounded-lg border p-3"
          style={{
            backgroundColor: 'var(--sam-color-bg-surface, #13201d)',
            borderColor: 'var(--sam-color-focus-ring, #34d399)',
          }}
        >
          <CommentComposer
            quote={composingAnchor.quote}
            onSubmit={(body, sendToAgent) =>
              addComment(anchorId, composingAnchor.quote, body, sendToAgent)
            }
            onCancel={() => setComposingAnchor(null)}
          />
        </div>
      ) : null,
    [composingAnchor, addComment]
  );

  const inlineThreads = !isWide;

  return (
    // Rule 37 / project policy: the app shell does not scroll at the document
    // level, so a prototype must own its own viewport-height scroll container.
    <div
      style={{ height: '100vh', overflow: 'auto' }}
      data-testid="comments-prototype"
      className="min-w-0"
    >
      <div className="mx-auto flex w-full min-w-0 max-w-[1400px] flex-col gap-4 p-3 sm:p-4">
        <Header
          surface={surface}
          onSurfaceChange={(s) => {
            setSurface(s);
            setOpenAnchorId(null);
            setComposingAnchor(null);
          }}
          dataset={dataset}
          onDatasetChange={setDataset}
          openCount={openCount}
        />

        <div className="flex min-w-0 gap-4">
          <main className="min-w-0 flex-1">
            {surface === 'chat' ? (
              <CommentableChat
                messages={MESSAGES}
                comments={surfaceComments}
                now={NOW}
                inlineThreads={inlineThreads}
                openAnchorId={openAnchorId}
                onOpenAnchor={setOpenAnchorId}
                onStartComment={startComment}
                onReply={handleReply}
                onToggleResolved={handleToggleResolved}
                renderComposer={renderComposer}
              />
            ) : (
              <CommentableMarkdown
                path={MARKDOWN_PATH}
                source={MARKDOWN_DOC}
                comments={surfaceComments}
                now={NOW}
                inlineThreads={inlineThreads}
                compact={!isWide}
                openAnchorId={openAnchorId}
                onOpenAnchor={setOpenAnchorId}
                onStartComment={startComment}
                onReply={handleReply}
                onToggleResolved={handleToggleResolved}
                renderComposer={renderComposer}
              />
            )}
          </main>

          {isWide && (
            <aside className="w-[360px] shrink-0" aria-label="Comments" data-testid="comment-rail">
              <div className="sticky top-4 flex flex-col gap-3">
                <div className="flex items-center gap-2">
                  <h2
                    className="m-0 flex items-center gap-1.5 text-sm font-semibold"
                    style={{ color: 'var(--sam-color-fg-primary, #e6f2ee)' }}
                  >
                    <CommentGlyph size={14} />
                    Comments
                  </h2>
                  <span className="text-xs" style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)' }}>
                    {openCount} open
                  </span>
                </div>
                <FilterRow filter={filter} onChange={setFilter} />
                <div className="flex max-h-[calc(100vh-140px)] flex-col gap-3 overflow-y-auto pr-1">
                  <CommentThreadList
                    comments={filteredForRail}
                    now={NOW}
                    onReply={handleReply}
                    onToggleResolved={handleToggleResolved}
                    focusedCommentId={
                      filteredForRail.find((c) =>
                        c.anchor.kind === 'message'
                          ? c.anchor.messageId === openAnchorId
                          : c.anchor.blockId === openAnchorId
                      )?.id ?? null
                    }
                    emptyMessage={
                      filter === 'all'
                        ? 'No comments yet. Select text or use the Comment action to start one.'
                        : `No ${filter} comments.`
                    }
                  />
                </div>
              </div>
            </aside>
          )}
        </div>
      </div>

      {/* The quote was captured into state when the selection settled, so clearing
          the live DOM selection here (which a tap does anyway on touch) is safe. */}
      {selection &&
        (coarsePointer ? (
          <SelectionActionBar
            quote={selection.quote}
            onComment={() => {
              startComment(selection.anchorId, selection.quote);
              window.getSelection()?.removeAllRanges();
              clearSelection();
            }}
            onDismiss={() => {
              window.getSelection()?.removeAllRanges();
              clearSelection();
            }}
          />
        ) : (
          <SelectionPopover
            x={selection.x}
            y={selection.y}
            onComment={() => {
              startComment(selection.anchorId, selection.quote);
              window.getSelection()?.removeAllRanges();
              clearSelection();
            }}
          />
        ))}
    </div>
  );
}

// ---------------------------------------------------------------------------

function Header({
  surface,
  onSurfaceChange,
  dataset,
  onDatasetChange,
  openCount,
}: {
  surface: Surface;
  onSurfaceChange: (s: Surface) => void;
  dataset: Dataset;
  onDatasetChange: (d: Dataset) => void;
  openCount: number;
}) {
  return (
    <header className="flex min-w-0 flex-col gap-3">
      <div className="flex min-w-0 flex-wrap items-baseline gap-x-3 gap-y-1">
        <h1
          className="m-0 text-lg font-semibold"
          style={{ color: 'var(--sam-color-fg-primary, #e6f2ee)' }}
        >
          Commenting prototype
        </h1>
        <span className="text-xs" style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)' }}>
          mock data · {openCount} open
        </span>
      </div>

      <div className="flex min-w-0 flex-wrap gap-2">
        <SegmentedControl
          label="Surface"
          value={surface}
          options={[
            { value: 'chat', label: 'Agent chat' },
            { value: 'file', label: 'Markdown file' },
          ]}
          onChange={onSurfaceChange}
        />
        <SegmentedControl
          label="Data"
          value={dataset}
          options={[
            { value: 'default', label: 'Default' },
            { value: 'empty', label: 'Empty' },
            { value: 'many', label: '32 threads' },
          ]}
          onChange={onDatasetChange}
        />
      </div>

      <p
        className="m-0 text-xs"
        style={{ color: 'var(--sam-color-fg-muted, #9fb7ae)', overflowWrap: 'anywhere' }}
      >
        Select any text to comment on that span, or use the Comment action to comment on a whole
        message.
      </p>
    </header>
  );
}

function SegmentedControl<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: { value: T; label: string }[];
  onChange: (v: T) => void;
}) {
  return (
    <div
      className="flex min-w-0 items-center gap-1 rounded-md border p-0.5"
      role="group"
      aria-label={label}
      style={{ borderColor: 'var(--sam-color-border-default, #29423b)' }}
    >
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            onClick={() => onChange(o.value)}
            aria-pressed={active}
            className="rounded px-2.5 py-1.5 text-xs font-medium whitespace-nowrap transition-colors focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-1"
            style={{
              backgroundColor: active
                ? 'var(--sam-color-accent-primary-tint, rgba(22,163,74,0.1))'
                : 'transparent',
              color: active
                ? 'var(--sam-color-success-fg, #4ade80)'
                : 'var(--sam-color-fg-muted, #9fb7ae)',
              outlineColor: 'var(--sam-color-focus-ring, #34d399)',
            }}
          >
            {o.label}
          </button>
        );
      })}
    </div>
  );
}

function FilterRow({ filter, onChange }: { filter: Filter; onChange: (f: Filter) => void }) {
  return (
    <div className="flex flex-wrap gap-1.5">
      {(['all', 'open', 'resolved'] as const).map((f) => (
        <Button
          key={f}
          size="sm"
          variant={filter === f ? 'secondary' : 'ghost'}
          onClick={() => onChange(f)}
        >
          {f === 'all' ? 'All' : f === 'open' ? 'Open' : 'Resolved'}
        </Button>
      ))}
    </div>
  );
}

export default CommentsPrototype;
