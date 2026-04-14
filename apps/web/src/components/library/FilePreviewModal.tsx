import { Spinner } from '@simple-agent-manager/ui';
import { AlertTriangle, Code, Download, Eye, X } from 'lucide-react';
import { useCallback, useEffect, useRef, useState } from 'react';

import {
  formatFileSize,
  isMarkdownMime,
  isPdfMime,
  isPreviewableImageMime,
} from '../../lib/file-utils';
import { RenderedMarkdown, SyntaxHighlightedCode } from '../MarkdownRenderer';
import { ImageViewer } from '../shared-file-viewer/ImageViewer';
import { type FileWithTags, FOCUS_RING } from './types';

export interface FilePreviewModalProps {
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

/** Default timeout for markdown content fetch (ms). */
const DEFAULT_MD_FETCH_TIMEOUT_MS = 30_000;
const MD_FETCH_TIMEOUT_MS = import.meta.env.VITE_MD_FETCH_TIMEOUT_MS
  ? parseInt(import.meta.env.VITE_MD_FETCH_TIMEOUT_MS, 10)
  : DEFAULT_MD_FETCH_TIMEOUT_MS;

export function FilePreviewModal({
  file,
  previewUrl,
  onClose,
  onDownload,
}: FilePreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pdfLoading, setPdfLoading] = useState(true);
  const [pdfError, setPdfError] = useState(false);

  const isImage = isPreviewableImageMime(file.mimeType);
  const isPdf = isPdfMime(file.mimeType);
  const isMarkdown = isMarkdownMime(file.mimeType);

  // Markdown state
  const [mdContent, setMdContent] = useState<string | null>(null);
  const [mdLoading, setMdLoading] = useState(false);
  const [mdError, setMdError] = useState<string | null>(null);
  const [mdViewMode, setMdViewMode] = useState<'rendered' | 'source'>('rendered');

  // Fetch markdown content as text from the preview endpoint
  useEffect(() => {
    if (!isMarkdown) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MD_FETCH_TIMEOUT_MS);
    setMdLoading(true);
    setMdError(null);

    fetch(previewUrl, { credentials: 'include', signal: controller.signal })
      .then((resp) => {
        if (!resp.ok) throw new Error(`Failed to load file (${resp.status})`);
        return resp.text();
      })
      .then((text) => {
        if (!controller.signal.aborted) {
          setMdContent(text);
          setMdLoading(false);
        }
      })
      .catch((err: Error) => {
        if (!controller.signal.aborted) {
          setMdError(err.name === 'AbortError' ? 'Request timed out' : err.message);
          setMdLoading(false);
        }
      })
      .finally(() => clearTimeout(timer));

    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [isMarkdown, previewUrl]);

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

  // Prevent body scroll
  useEffect(() => {
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = '';
    };
  }, []);

  // Focus trap: cycle Tab between focusable elements within the dialog
  const handleTabTrap = useCallback(
    (e: KeyboardEvent) => {
      if (e.key !== 'Tab') return;
      const dialog = dialogRef.current;
      if (!dialog) return;

      const focusable = dialog.querySelectorAll<HTMLElement>(
        'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
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
    },
    [],
  );

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

  return (
    <div className="fixed inset-0 z-dialog-backdrop overflow-hidden">
      {/* Backdrop */}
      <div
        className="fixed inset-0 bg-overlay transition-opacity duration-150"
        onClick={onClose}
      />

      {/* Modal panel */}
      <div className="flex items-center justify-center h-full p-4 sm:p-6">
        <div
          ref={dialogRef}
          tabIndex={-1}
          role="dialog"
          aria-modal="true"
          aria-labelledby="preview-modal-title"
          className="relative z-dialog bg-surface rounded-lg shadow-overlay border border-border-default w-full max-w-4xl max-h-[90vh] flex flex-col outline-none"
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default shrink-0">
            <div className="flex-1 min-w-0">
              <h3
                id="preview-modal-title"
                className="text-sm font-semibold text-fg-primary truncate"
                title={file.filename}
              >
                {file.filename}
              </h3>
              <span className="text-xs text-fg-muted">
                {formatFileSize(file.sizeBytes)}
              </span>
            </div>

            {/* Markdown rendered/source toggle */}
            {isMarkdown && mdContent !== null && (
              <div className="flex rounded-lg border border-border-default overflow-hidden shrink-0">
                <button
                  type="button"
                  onClick={() => setMdViewMode('rendered')}
                  aria-label="Rendered view"
                  aria-pressed={mdViewMode === 'rendered'}
                  className={`flex items-center gap-1.5 px-2.5 py-2 text-xs border-none cursor-pointer ${FOCUS_RING} ${
                    mdViewMode === 'rendered'
                      ? 'bg-accent/10 text-accent'
                      : 'bg-surface text-fg-muted hover:text-fg-primary'
                  }`}
                >
                  <Eye size={14} />
                  Rendered
                </button>
                <button
                  type="button"
                  onClick={() => setMdViewMode('source')}
                  aria-label="Source view"
                  aria-pressed={mdViewMode === 'source'}
                  className={`flex items-center gap-1.5 px-2.5 py-2 text-xs border-none cursor-pointer ${FOCUS_RING} ${
                    mdViewMode === 'source'
                      ? 'bg-accent/10 text-accent'
                      : 'bg-surface text-fg-muted hover:text-fg-primary'
                  }`}
                >
                  <Code size={14} />
                  Source
                </button>
              </div>
            )}

            <button
              type="button"
              onClick={onDownload}
              className={`flex items-center gap-1.5 px-3 py-2.5 text-xs font-medium rounded-md border border-border-default bg-transparent text-fg-primary cursor-pointer hover:bg-surface-hover min-h-[44px] ${FOCUS_RING}`}
              aria-label={`Download ${file.filename}`}
            >
              <Download size={14} />
              Download
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

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-auto">
            {isImage && (
              <ImageViewer
                src={previewUrl}
                fileName={file.filename}
                fileSize={file.sizeBytes}
              />
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
                    className="w-full h-full border-none min-h-[60vh]"
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
                {mdContent !== null && !mdLoading && !mdError && (
                  mdViewMode === 'rendered' ? (
                    <RenderedMarkdown content={mdContent} />
                  ) : (
                    <div className="p-4 overflow-auto bg-surface-inset rounded-md m-2">
                      <SyntaxHighlightedCode content={mdContent} language="markdown" />
                    </div>
                  )
                )}
              </>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
