import { Spinner } from '@simple-agent-manager/ui';
import { AlertTriangle, Code, Download, Eye, MessageSquare, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { useFileTextContent } from '../../hooks/useFileTextContent';
import { useScrollLock } from '../../hooks/useScrollLock';
import {
  FILE_PREVIEW_LOAD_MAX_BYTES,
  formatFileSize,
  isHtmlMime,
  isMarkdownMime,
  isPdfMime,
  isPreviewableImageMime,
} from '../../lib/file-utils';
import { RenderedMarkdown, SyntaxHighlightedCode } from '../MarkdownRenderer';
import {
  SelectionActionBar,
  SelectionPopover,
} from '../project-message-view/comments/CommentPrimitives';
import {
  useCoarsePointer,
  useCommentSelection,
} from '../project-message-view/comments/useCommentSelection';
import { ImageViewer } from '../shared-file-viewer/ImageViewer';
import { FileCommentPanel } from './FileCommentPanel';
import { InteractiveHtmlPreview } from './InteractiveHtmlPreview';
import { type FileWithTags, FOCUS_RING } from './types';

export interface FilePreviewModalProps {
  projectId: string;
  file: FileWithTags;
  previewUrl: string;
  onClose: () => void;
  onDownload: () => void;
}

/** Default timeout for PDF iframe loading before showing error state (ms). */
const DEFAULT_PDF_LOAD_TIMEOUT_MS = 15_000;
const PDF_LOAD_TIMEOUT_MS = import.meta.env.VITE_PDF_LOAD_TIMEOUT_MS
  ? parseInt(import.meta.env.VITE_PDF_LOAD_TIMEOUT_MS, 10)
  : DEFAULT_PDF_LOAD_TIMEOUT_MS;

const TOGGLE_BUTTON_BASE =
  'flex items-center gap-1.5 px-2.5 py-2 text-xs border-none cursor-pointer';
const TOGGLE_BUTTON_INACTIVE =
  'bg-[color-mix(in_srgb,var(--sam-glass-nested-bg)_80%,transparent)] text-fg-muted hover:text-fg-primary';

/**
 * Two-way primary/source view switch used by both the markdown and HTML branches so a single
 * control shape governs every "rendered vs. raw" choice in the modal header.
 */
function ViewToggle({
  primaryLabel,
  primaryAriaLabel,
  isPrimary,
  onPrimary,
  onSource,
}: {
  primaryLabel: string;
  primaryAriaLabel: string;
  isPrimary: boolean;
  onPrimary: () => void;
  onSource: () => void;
}) {
  return (
    <div className="flex shrink-0 overflow-hidden rounded-lg border border-border-default">
      <button
        type="button"
        onClick={onPrimary}
        aria-label={primaryAriaLabel}
        aria-pressed={isPrimary}
        className={`${TOGGLE_BUTTON_BASE} ${FOCUS_RING} ${
          isPrimary ? 'bg-accent/10 text-accent' : TOGGLE_BUTTON_INACTIVE
        }`}
      >
        <Eye size={14} />
        <span className="hidden sm:inline">{primaryLabel}</span>
      </button>
      <button
        type="button"
        onClick={onSource}
        aria-label="Source view"
        aria-pressed={!isPrimary}
        className={`${TOGGLE_BUTTON_BASE} ${FOCUS_RING} ${
          !isPrimary ? 'bg-accent/10 text-accent' : TOGGLE_BUTTON_INACTIVE
        }`}
      >
        <Code size={14} />
        <span className="hidden sm:inline">Source</span>
      </button>
    </div>
  );
}

export function FilePreviewModal({
  projectId,
  file,
  previewUrl,
  onClose,
  onDownload,
}: FilePreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [pdfError, setPdfError] = useState(false);
  const [commentsOpen, setCommentsOpen] = useState(false);
  const [pendingQuote, setPendingQuote] = useState<string | null>(null);
  // Pass the filename so an octet-stream/empty stored type (agent uploads) still
  // resolves to its real previewable type from the extension.
  const isImage = isPreviewableImageMime(file.mimeType, file.filename);
  const isPdf = isPdfMime(file.mimeType, file.filename);
  const isMarkdown = isMarkdownMime(file.mimeType, file.filename);
  const isHtml = isHtmlMime(file.mimeType, file.filename);
  // HTML artifacts run interactively; anything above the load ceiling is download-only.
  const htmlTooLarge = isHtml && file.sizeBytes > FILE_PREVIEW_LOAD_MAX_BYTES;

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

  // PDF loading timeout
  useEffect(() => {
    if (!isPdf || !pdfLoading) return;
    const timer = setTimeout(() => {
      if (pdfLoading) {
        setPdfLoading(false);
        setPdfError(true);
      }
    }, PDF_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [isPdf, pdfLoading]);

  return createPortal(
    <div className="fixed inset-0 z-dialog-backdrop overflow-hidden bg-surface">
      <div className="fixed inset-0 glass-backdrop-dim" aria-hidden="true" />
      <div className="fixed inset-0 h-[100dvh] overflow-hidden">
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-modal-title"
          className="relative z-dialog flex h-[100dvh] w-full flex-col overflow-hidden bg-surface outline-none"
        >
          {/* Header */}
          <div
            className="flex shrink-0 items-center gap-3 border-b border-border-default bg-surface px-4 py-3"
            style={{
              paddingTop: 'calc(env(safe-area-inset-top) + 0.75rem)',
              paddingLeft: 'calc(env(safe-area-inset-left) + 1rem)',
              paddingRight: 'calc(env(safe-area-inset-right) + 1rem)',
            }}
          >
            <div className="min-w-0 flex-1">
              <h3
                id="preview-modal-title"
                className="text-sm font-semibold text-fg-primary truncate"
                title={file.filename}
              >
                {file.filename}
              </h3>
              <span className="text-xs text-fg-muted">{formatFileSize(file.sizeBytes)}</span>
            </div>

            {/* Markdown rendered/source toggle */}
            {isMarkdown && mdContent !== null && (
              <ViewToggle
                primaryLabel="Rendered"
                primaryAriaLabel="Rendered view"
                isPrimary={mdViewMode === 'rendered'}
                onPrimary={() => setMdViewMode('rendered')}
                onSource={() => setMdViewMode('source')}
              />
            )}

            {/* HTML preview/source toggle — same control as markdown so the two behave alike and
                the artifact viewer needs no toolbar row of its own. */}
            {isHtml && !htmlTooLarge && (
              <ViewToggle
                primaryLabel="Preview"
                primaryAriaLabel="Interactive preview"
                isPrimary={htmlViewMode === 'preview'}
                onPrimary={() => setHtmlViewMode('preview')}
                onSource={() => setHtmlViewMode('source')}
              />
            )}

            <button
              type="button"
              onClick={onDownload}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-md border border-border-default bg-transparent text-fg-primary cursor-pointer hover:bg-surface-hover min-h-[44px] ${FOCUS_RING}`}
              aria-label={`Download ${file.filename}`}
            >
              <Download size={14} />
              <span className="hidden sm:inline">Download</span>
            </button>
            <button
              type="button"
              onClick={() => setCommentsOpen((prev) => !prev)}
              aria-pressed={commentsOpen}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-md border cursor-pointer min-h-[44px] ${FOCUS_RING} ${
                commentsOpen
                  ? 'border-accent bg-accent/10 text-accent'
                  : 'border-border-default bg-transparent text-fg-primary hover:bg-surface-hover'
              }`}
              aria-label={commentsOpen ? 'Hide comments' : 'Show comments'}
            >
              <MessageSquare size={14} />
              <span className="hidden sm:inline">Comments</span>
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`p-3 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded min-w-[44px] min-h-[44px] flex items-center justify-center ${FOCUS_RING}`}
              aria-label="Close preview"
            >
              <X size={18} />
            </button>
          </div>

          {/* Content + optional comment panel */}
          <div className="flex min-h-0 flex-1 overflow-hidden">
            {/* File content area.
                The HTML branch needs a real flex context so the preview iframe can claim the full
                remaining height; the image/PDF/markdown branches depend on this wrapper being a
                block `overflow-auto` scroller (PDF uses `h-full` under a block parent, markdown
                scrolls here), so the flex context is applied only for HTML. */}
            <div
              className={
                isHtml
                  ? 'flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden'
                  : 'min-h-0 min-w-0 flex-1 overflow-auto'
              }
              style={{
                paddingBottom: 'env(safe-area-inset-bottom)',
                paddingLeft: 'env(safe-area-inset-left)',
                paddingRight: commentsOpen ? undefined : 'env(safe-area-inset-right)',
              }}
            >
              {isImage && (
                <ImageViewer src={previewUrl} fileName={file.filename} fileSize={file.sizeBytes} />
              )}

              {isPdf && (
                <div className="relative h-full min-h-[60vh]">
                  {pdfLoading && !pdfError && (
                    <div className="absolute inset-0 flex items-center justify-center">
                      <Spinner size="md" />
                    </div>
                  )}
                  {pdfError ? (
                    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center min-h-[60vh]">
                      <AlertTriangle size={32} className="text-warning" />
                      <p className="text-sm text-fg-muted">
                        Unable to load PDF preview. Try downloading the file instead.
                      </p>
                      <button
                        type="button"
                        onClick={onDownload}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border-default bg-transparent text-fg-primary cursor-pointer hover:bg-surface-hover ${FOCUS_RING}`}
                      >
                        <Download size={14} />
                        Download
                      </button>
                    </div>
                  ) : (
                    <iframe
                      src={previewUrl}
                      title={`Preview of ${file.filename}`}
                      sandbox="allow-same-origin"
                      className="h-full min-h-[60vh] w-full border-none"
                      onLoad={() => setPdfLoading(false)}
                      onError={() => {
                        setPdfLoading(false);
                        setPdfError(true);
                      }}
                    />
                  )}
                </div>
              )}

              {isMarkdown && (
                <>
                  {mdLoading && (
                    <div className="flex items-center justify-center py-12">
                      <Spinner size="md" />
                    </div>
                  )}
                  {mdError && (
                    <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                      <AlertTriangle size={32} className="text-warning" />
                      <p className="text-sm text-fg-muted">
                        Unable to load markdown preview. Try downloading the file instead.
                      </p>
                      <button
                        type="button"
                        onClick={onDownload}
                        className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border-default bg-transparent text-fg-primary cursor-pointer hover:bg-surface-hover ${FOCUS_RING}`}
                      >
                        <Download size={14} />
                        Download
                      </button>
                    </div>
                  )}
                  {mdContent !== null &&
                    !mdLoading &&
                    !mdError &&
                    (mdViewMode === 'rendered' ? (
                      <div ref={previewBodyRef} data-comment-anchor={file.id}>
                        <RenderedMarkdown content={mdContent} />
                      </div>
                    ) : (
                      <div className="overflow-auto bg-surface-inset p-4">
                        <SyntaxHighlightedCode content={mdContent} language="markdown" />
                      </div>
                    ))}
                </>
              )}

              {isHtml && htmlTooLarge && (
                <div className="flex flex-col items-center justify-center gap-3 p-8 text-center">
                  <AlertTriangle size={32} className="text-warning" />
                  <p className="text-sm text-fg-muted">
                    This file is too large to preview. Download it to view the contents.
                  </p>
                  <button
                    type="button"
                    onClick={onDownload}
                    className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border-default bg-transparent text-fg-primary cursor-pointer hover:bg-surface-hover ${FOCUS_RING}`}
                  >
                    <Download size={14} />
                    Download
                  </button>
                </div>
              )}

              {isHtml &&
                !htmlTooLarge &&
                (htmlViewMode === 'preview' ? (
                  <InteractiveHtmlPreview file={file} />
                ) : (
                  <div className="min-h-0 flex-1 overflow-auto bg-surface-inset p-4">
                    {htmlSourceLoading && htmlSource === null && (
                      <div className="flex items-center justify-center py-12">
                        <Spinner size="md" />
                      </div>
                    )}
                    {htmlSourceError && htmlSource === null && (
                      <p role="alert" className="text-sm text-fg-muted">
                        Unable to load the HTML source. Try downloading the file instead.
                      </p>
                    )}
                    {htmlSource !== null && (
                      <SyntaxHighlightedCode content={htmlSource} language="markup" />
                    )}
                  </div>
                ))}
            </div>

            {/* Comment panel — side panel on desktop, overlay on mobile */}
            {commentsOpen && (
              <div
                className="absolute inset-y-0 right-0 w-full border-l border-border-default sm:relative sm:w-80 lg:w-96"
                style={{ paddingRight: 'env(safe-area-inset-right)' }}
              >
                <FileCommentPanel
                  projectId={projectId}
                  fileId={file.id}
                  pendingQuote={pendingQuote}
                  onClearPendingQuote={() => setPendingQuote(null)}
                  onClose={() => {
                    setPendingQuote(null);
                    setCommentsOpen(false);
                  }}
                />
              </div>
            )}
          </div>
        </div>
      </div>

      {selection &&
        (coarsePointer ? (
          <SelectionActionBar
            quote={selection.quote}
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
