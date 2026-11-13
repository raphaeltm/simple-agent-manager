import { IconButton, paneClassName, SegmentedControl } from '@simple-agent-manager/ui';
import { Code, Download, Eye, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useFileTextContent } from '../../hooks/useFileTextContent';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useScrollLock } from '../../hooks/useScrollLock';
import { formatFileSize } from '../../lib/file-utils';
import type { UiCommentThread } from '../project-message-view/comments/comment-utils';
import {
  SelectionActionBar,
  SelectionPopover,
} from '../project-message-view/comments/CommentPrimitives';
import { useCommentQuoteHighlights } from '../project-message-view/comments/useCommentQuoteHighlights';
import {
  useCoarsePointer,
  useCommentSelection,
} from '../project-message-view/comments/useCommentSelection';
import { FileCommentPanel } from './FileCommentPanel';
import { FileLinkedWorkSection } from './FileLinkedWorkSection';
import { FilePreviewContent, isTooLargeToPreview, previewKindOf } from './FilePreviewContent';
import type { FileWithTags } from './types';
import { useLibraryFileComments } from './useLibraryFileComments';

export interface FilePreviewModalProps {
  projectId: string;
  file: FileWithTags;
  previewUrl: string;
  onClose: () => void;
  onDownload: () => void;
  /** Open with the comments panel showing this thread, from a comment deep link. */
  initialCommentThreadId?: string | null;
}

export function FilePreviewModal({
  projectId,
  file,
  previewUrl,
  onClose,
  onDownload,
  initialCommentThreadId = null,
}: FilePreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const isMobile = useIsMobile();
  const [commentsOpen, setCommentsOpen] = useState(Boolean(initialCommentThreadId));
  const [focusedThreadId, setFocusedThreadId] = useState<string | null>(initialCommentThreadId);
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  const kind = previewKindOf(file);
  const isMarkdown = kind === 'markdown';
  const isHtml = kind === 'html';

  const [mdViewMode, setMdViewMode] = useState<'rendered' | 'source'>('rendered');

  // Selecting text in the rendered markdown offers "Comment on selection", which
  // opens the panel with the quote attached. Reuses the same selection machinery
  // as message comments — the preview body just declares itself an anchor.
  const previewBodyRef = useRef<HTMLDivElement>(null);
  const coarsePointer = useCoarsePointer();
  const { selection, clear: clearSelection } = useCommentSelection(
    isMarkdown && mdViewMode === 'rendered',
    previewBodyRef
  );

  // Threads load with a markdown file so their quotes can be painted on it; for other files,
  // when the comments panel opens. The panel reads this same controller.
  const fileComments = useLibraryFileComments(projectId, file.id, isMarkdown || commentsOpen);
  const previewPaneRef = useRef<HTMLElement>(null);
  const openThread = useCallback((thread: UiCommentThread) => {
    setFocusedThreadId(thread.id);
    setCommentsOpen(true);
  }, []);
  useCommentQuoteHighlights({
    containerRef: previewPaneRef,
    threads: fileComments.comments,
    // Every thread here is on this file, whose rendered markdown carries the file id as its
    // comment anchor (`FilePreviewContent`).
    itemIdOf: () => file.id,
    activeThreadId: commentsOpen ? focusedThreadId : null,
    revealKey: focusedThreadId,
    enabled: isMarkdown && mdViewMode === 'rendered',
    onOpenThread: openThread,
  });

  const startQuotedComment = useCallback(() => {
    if (!selection) return;
    setPendingQuote(selection.quote);
    setCommentsOpen(true);
    clearSelection();
    window.getSelection()?.removeAllRanges();
  }, [clearSelection, selection]);
  // HTML defaults to the running preview. Source is the alternate view, and is fetched lazily so
  // opening an artifact costs one request (the signed-URL mint) instead of two.
  const [htmlViewMode, setHtmlViewMode] = useState<'preview' | 'source'>('preview');

  const {
    content: mdContent,
    loading: mdLoading,
    error: mdError,
  } = useFileTextContent(previewUrl, isMarkdown);
  const {
    content: htmlSource,
    loading: htmlSourceLoading,
    error: htmlSourceError,
  } = useFileTextContent(previewUrl, isHtml && htmlViewMode === 'source');

  // Escape key handler
  useEffect(() => {
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        onClose();
      }
    };
    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [onClose]);

  // Prevent body scroll — always active while this modal is mounted
  useScrollLock(true);

  // Focus trap: cycle Tab between focusable elements within the dialog
  const handleTabTrap = useCallback((e: KeyboardEvent) => {
    if (e.key !== 'Tab') return;
    const dialog = dialogRef.current;
    if (!dialog) return;

    const focusable = dialog.querySelectorAll<HTMLElement>(
      'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])'
    );
    if (focusable.length === 0) return;

    const first = focusable[0] as HTMLElement | undefined;
    const last = focusable[focusable.length - 1] as HTMLElement | undefined;
    if (!first || !last) return;

    if (e.shiftKey) {
      if (document.activeElement === first || document.activeElement === dialog) {
        e.preventDefault();
        last.focus();
      }
    } else {
      if (document.activeElement === last) {
        e.preventDefault();
        first.focus();
      }
    }
  }, []);

  useEffect(() => {
    document.addEventListener('keydown', handleTabTrap);
    return () => document.removeEventListener('keydown', handleTabTrap);
  }, [handleTabTrap]);

  // Focus dialog on mount and return focus on close
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);

  const showMdToggle = kind === 'markdown' && mdContent !== null;
  const showHtmlToggle = kind === 'html' && !isTooLargeToPreview(kind, file.sizeBytes);

  return createPortal(
    // The viewer is its own screen: a void with the header slab and the artifact pane floating
    // on it. The frame and gutter are the shell's immersive ones, so the artifact keeps nearly
    // the whole viewport.
    <div className="sam-void fixed inset-0 z-dialog-backdrop flex flex-col overflow-hidden pb-[max(env(safe-area-inset-bottom),0.375rem)] pl-[max(env(safe-area-inset-left),0.375rem)] pr-[max(env(safe-area-inset-right),0.375rem)] pt-[max(env(safe-area-inset-top),0.375rem)] md:p-2.5">
      <div
        ref={dialogRef}
        tabIndex={-1}
        role="dialog"
        aria-modal="true"
        aria-labelledby="preview-modal-title"
        className="relative z-dialog flex min-h-0 flex-1 flex-col gap-1.5 outline-none md:gap-2.5"
      >
        {/* One slab: name and size, where the file came from, then the controls. */}
        <header
          className={`${paneClassName('slab')} relative z-10 flex shrink-0 items-center gap-1 py-1 pl-3.5 pr-1 md:pl-4`}
        >
          <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
            <h3
              id="preview-modal-title"
              className="m-0 truncate text-sm font-semibold text-fg-primary md:text-[15px]"
              title={file.filename}
            >
              {file.filename}
            </h3>
            <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
              <span className="shrink-0 font-mono">{formatFileSize(file.sizeBytes)}</span>
              <FileLinkedWorkSection projectId={projectId} fileId={file.id} />
            </div>
          </div>

          {/* Rendered/source: one control for markdown and HTML, so both behave alike. */}
          {showMdToggle && (
            <SegmentedControl
              label="Markdown view"
              size={isMobile ? 'lg' : 'md'}
              className="shrink-0"
              value={mdViewMode}
              onChange={setMdViewMode}
              options={[
                {
                  value: 'rendered',
                  ariaLabel: 'Rendered view',
                  icon: <Eye size={14} aria-hidden="true" />,
                  label: <span className="max-md:hidden">Rendered</span>,
                },
                {
                  value: 'source',
                  ariaLabel: 'Source view',
                  icon: <Code size={14} aria-hidden="true" />,
                  label: <span className="max-md:hidden">Source</span>,
                },
              ]}
            />
          )}
          {showHtmlToggle && (
            <SegmentedControl
              label="HTML view"
              size={isMobile ? 'lg' : 'md'}
              className="shrink-0"
              value={htmlViewMode}
              onChange={setHtmlViewMode}
              options={[
                {
                  value: 'preview',
                  ariaLabel: 'Interactive preview',
                  icon: <Eye size={14} aria-hidden="true" />,
                  label: <span className="max-md:hidden">Preview</span>,
                },
                {
                  value: 'source',
                  ariaLabel: 'Source view',
                  icon: <Code size={14} aria-hidden="true" />,
                  label: <span className="max-md:hidden">Source</span>,
                },
              ]}
            />
          )}

          <IconButton
            label={`Download ${file.filename}`}
            icon={<Download size={18} aria-hidden="true" />}
            onClick={onDownload}
          />
          <IconButton
            label={commentsOpen ? 'Hide comments' : 'Show comments'}
            icon={<MessageSquare size={18} aria-hidden="true" />}
            aria-pressed={commentsOpen}
            raised={commentsOpen}
            onClick={() => {
              if (commentsOpen) setFocusedThreadId(null);
              setCommentsOpen(!commentsOpen);
            }}
          />
          <IconButton
            label="Close preview"
            icon={<X size={18} aria-hidden="true" />}
            onClick={onClose}
          />
        </header>

        {/* The artifact pane, and the comments pane beside it (over it on phones). */}
        <div className="relative flex min-h-0 flex-1 gap-2.5 md:gap-[var(--sam-space-gutter)]">
          <section
            ref={previewPaneRef}
            aria-label={`Preview of ${file.filename}`}
            className={`${paneClassName('quiet')} relative min-h-0 min-w-0 flex-1 ${
              // HTML needs a flex column so its iframe can claim the full height; the other
              // viewers scroll inside the pane.
              kind === 'html' ? 'flex flex-col overflow-hidden' : 'overflow-auto'
            }`}
          >
            <FilePreviewContent
              file={file}
              kind={kind}
              previewUrl={previewUrl}
              onDownload={onDownload}
              markdown={{
                mode: mdViewMode,
                content: mdContent,
                loading: mdLoading,
                error: mdError,
                bodyRef: previewBodyRef,
              }}
              html={{
                mode: htmlViewMode,
                source: htmlSource,
                loading: htmlSourceLoading,
                error: htmlSourceError,
              }}
            />
          </section>

          {commentsOpen && (
            <aside
              aria-label="File comments"
              className={`${paneClassName(isMobile ? 'overlay' : 'pane')} absolute inset-0 z-10 overflow-hidden md:relative md:inset-auto md:w-80 md:shrink-0 lg:w-96`}
            >
              <FileCommentPanel
                fileComments={fileComments}
                focusedThreadId={focusedThreadId}
                pendingQuote={pendingQuote}
                onClearPendingQuote={() => setPendingQuote(null)}
                onClose={() => {
                  setPendingQuote(null);
                  setFocusedThreadId(null);
                  setCommentsOpen(false);
                }}
              />
            </aside>
          )}
        </div>
      </div>

      {selection &&
        (coarsePointer ? (
          <SelectionActionBar
            quote={selection.quote}
            selectionBottom={selection.rectBottom}
            onComment={startQuotedComment}
            onDismiss={() => {
              clearSelection();
              window.getSelection()?.removeAllRanges();
            }}
          />
        ) : (
          <SelectionPopover x={selection.x} y={selection.y} onComment={startQuotedComment} />
        ))}
    </div>,
    document.body
  );
}
