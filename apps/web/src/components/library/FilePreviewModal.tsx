import { IconButton, paneClassName, SegmentedControl } from '@simple-agent-manager/ui';
import { Code, Download, Eye, FolderOpen, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState } from 'react';

import { useFileTextContent } from '../../hooks/useFileTextContent';
import { useIsMobile } from '../../hooks/useIsMobile';
import { useScrollLock } from '../../hooks/useScrollLock';
import { formatFileSize } from '../../lib/file-utils';
import { useDialogFocusTrap } from '../chat/useDialogFocusTrap';
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
import { isTopmostPreview, PreviewFrame, type PreviewPresentation } from './PreviewFrame';
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
  /** `overlay` floats over the referencing page on wider screens (`PreviewFrame`). */
  presentation?: PreviewPresentation;
  /** Shown as "Open in Library" when the viewer was opened from outside the Library. */
  onOpenInLibrary?: () => void;
}

export function FilePreviewModal({
  projectId,
  file,
  previewUrl,
  onClose,
  onDownload,
  initialCommentThreadId = null,
  presentation = 'screen',
  onOpenInLibrary,
}: FilePreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
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
    // Only a comment link brings its words on screen; a click on them is already looking.
    revealKey: initialCommentThreadId,
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

  // Prevent body scroll — always active while this modal is mounted
  useScrollLock(true);

  const closeComments = useCallback(() => {
    setPendingQuote(null);
    setFocusedThreadId(null);
    setCommentsOpen(false);
  }, []);

  // Escape steps back one layer and never throws away typing: a half-written comment stays, an
  // open comments panel closes before the viewer does.
  const handleEscape = useCallback(() => {
    const active = document.activeElement;
    if (
      (active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement) &&
      active.value.trim() !== ''
    ) {
      return;
    }
    if (commentsOpen) {
      closeComments();
      return;
    }
    onClose();
  }, [closeComments, commentsOpen, onClose]);
  const isTopmost = useCallback(() => isTopmostPreview(dialogRef.current), []);

  // Focus dialog on mount and return focus on close
  const previousFocusRef = useRef<HTMLElement | null>(null);
  useEffect(() => {
    previousFocusRef.current = document.activeElement as HTMLElement | null;
    dialogRef.current?.focus();
    return () => {
      previousFocusRef.current?.focus();
    };
  }, []);
  // Tab stays inside the viewer (and is pulled back in if focus strayed), Escape as above. Only
  // the topmost viewer listens, when one file's markdown opened another over it.
  useDialogFocusTrap(dialogRef, handleEscape, true, isTopmost);

  const showMdToggle = kind === 'markdown' && mdContent !== null;
  const showHtmlToggle = kind === 'html' && !isTooLargeToPreview(kind, file.sizeBytes);

  return (
    <PreviewFrame
      presentation={presentation}
      dialogRef={dialogRef}
      onClose={onClose}
      aria-labelledby={titleId}
      outside={
        selection &&
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
        ))
      }
    >
      {/* One slab: name and size, where the file came from, then the controls. On a phone the
          controls take a second row, so the name keeps the width it needs to be read; Close
          stays on the first row, in the corner where a phone user looks for it. */}
      <header
        className={`${paneClassName('slab')} relative z-10 grid shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-x-1 py-1 pl-3.5 pr-1 md:flex md:pl-4`}
      >
        <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-1">
          <h3
            id={titleId}
            // Wraps rather than truncating: a one-line ellipsis hides which file is open, and a
            // phone has no hover to read the `title` tooltip.
            className="m-0 line-clamp-3 break-words md:line-clamp-2 text-sm leading-snug font-semibold text-fg-primary [overflow-wrap:anywhere] md:text-[15px]"
            title={file.filename}
          >
            {file.filename}
          </h3>
          <div className="flex min-w-0 items-center gap-1.5 text-xs text-fg-muted">
            <span className="shrink-0 font-mono">{formatFileSize(file.sizeBytes)}</span>
            <FileLinkedWorkSection projectId={projectId} fileId={file.id} />
          </div>
        </div>

        <div className="col-span-2 flex items-center justify-end gap-1 pb-0.5 md:contents">
          {/* Rendered/source: one control for markdown and HTML, so both behave alike. */}
          {showMdToggle && (
            <SegmentedControl
              label="Markdown view"
              size={isMobile ? 'lg' : 'md'}
              // Segments sized to their labels, so "Rendered" is not cut to fit "Source".
              className="shrink-0 [&>button]:flex-auto"
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
              // Segments sized to their labels, so "Rendered" is not cut to fit "Source".
              className="shrink-0 [&>button]:flex-auto"
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

          {onOpenInLibrary && (
            <IconButton
              label="Open in Library"
              icon={<FolderOpen size={18} aria-hidden="true" />}
              onClick={onOpenInLibrary}
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
        </div>
        <IconButton
          label="Close preview"
          icon={<X size={18} aria-hidden="true" />}
          onClick={onClose}
          className="max-md:col-start-2 max-md:row-start-1"
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
    </PreviewFrame>
  );
}
