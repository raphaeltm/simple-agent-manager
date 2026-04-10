import { Spinner } from '@simple-agent-manager/ui';
import { Download, X } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';

import {
  formatFileSize,
  isPdfMime,
  isPreviewableImageMime,
} from '../../lib/file-utils';
import { ImageViewer } from '../shared-file-viewer/ImageViewer';
import { type FileWithTags, FOCUS_RING } from './types';

export interface FilePreviewModalProps {
  file: FileWithTags;
  previewUrl: string;
  onClose: () => void;
  onDownload: () => void;
}

export function FilePreviewModal({
  file,
  previewUrl,
  onClose,
  onDownload,
}: FilePreviewModalProps) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const [pdfLoading, setPdfLoading] = useState(true);

  const isImage = isPreviewableImageMime(file.mimeType);
  const isPdf = isPdfMime(file.mimeType);

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

  // Focus trap
  useEffect(() => {
    dialogRef.current?.focus();
  }, []);

  return (
    <div
      className="fixed inset-0 z-dialog-backdrop overflow-hidden"
      aria-labelledby="preview-modal-title"
      role="dialog"
      aria-modal="true"
    >
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
          className="relative bg-surface rounded-lg shadow-overlay border border-border-default w-full max-w-4xl max-h-[90vh] flex flex-col outline-none"
        >
          {/* Header */}
          <div className="flex items-center gap-3 px-4 py-3 border-b border-border-default shrink-0">
            <div className="flex-1 min-w-0">
              <h3
                id="preview-modal-title"
                className="text-sm font-semibold text-fg-primary truncate"
              >
                {file.filename}
              </h3>
              <span className="text-xs text-fg-muted">
                {formatFileSize(file.sizeBytes)}
              </span>
            </div>
            <button
              type="button"
              onClick={onDownload}
              className={`flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium rounded-md border border-border-default bg-transparent text-fg-primary cursor-pointer hover:bg-surface-hover ${FOCUS_RING}`}
              aria-label={`Download ${file.filename}`}
            >
              <Download size={14} />
              Download
            </button>
            <button
              type="button"
              onClick={onClose}
              className={`p-1.5 bg-transparent border-none cursor-pointer text-fg-muted hover:text-fg-primary rounded ${FOCUS_RING}`}
              aria-label="Close preview"
            >
              <X size={18} />
            </button>
          </div>

          {/* Content */}
          <div className="flex-1 min-h-0 overflow-hidden">
            {isImage && (
              <ImageViewer
                src={previewUrl}
                fileName={file.filename}
                fileSize={file.sizeBytes}
              />
            )}

            {isPdf && (
              <div className="relative h-full">
                {pdfLoading && (
                  <div className="absolute inset-0 flex items-center justify-center">
                    <Spinner size="md" />
                  </div>
                )}
                <iframe
                  src={previewUrl}
                  title={`Preview of ${file.filename}`}
                  sandbox="allow-scripts allow-same-origin"
                  className="w-full h-full border-none"
                  style={{ minHeight: '60vh' }}
                  onLoad={() => setPdfLoading(false)}
                />
              </div>
            )}
          </div>
        </div>
      </div>
    </div>
  );
}
