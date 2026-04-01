import { Spinner } from '@simple-agent-manager/ui';
import { type FC, useCallback, useEffect, useState } from 'react';

import {
  FILE_PREVIEW_INLINE_MAX_BYTES,
  FILE_PREVIEW_LOAD_MAX_BYTES,
  formatFileSize,
} from '../../lib/file-utils';

interface ImageViewerProps {
  /** URL to fetch the raw image from. */
  src: string;
  /** File name for display. */
  fileName: string;
  /** File size in bytes (if known from directory listing). */
  fileSize?: number;
}

/**
 * Renders an image with fit-to-panel / 1:1 toggle, metadata display,
 * and size-based guardrails (click-to-load for large files, download-only for very large).
 *
 * Images are rendered via <img src> tag — SVGs are safe in this context
 * because browsers block script execution inside <img> elements.
 */
export const ImageViewer: FC<ImageViewerProps> = ({ src, fileName, fileSize }) => {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);
  const [dimensions, setDimensions] = useState<{ w: number; h: number } | null>(null);
  const [actualSize, setActualSize] = useState(false);
  const [userConfirmedLoad, setUserConfirmedLoad] = useState(false);

  // Determine size tier
  const isLargeFile = fileSize != null && fileSize > FILE_PREVIEW_INLINE_MAX_BYTES;
  const isTooLarge = fileSize != null && fileSize > FILE_PREVIEW_LOAD_MAX_BYTES;

  // Should we show the image?
  const shouldRender = !isTooLarge && (!isLargeFile || userConfirmedLoad);

  const handleLoad = useCallback((e: React.SyntheticEvent<HTMLImageElement>) => {
    const img = e.currentTarget;
    setDimensions({ w: img.naturalWidth, h: img.naturalHeight });
    setLoading(false);
  }, []);

  const handleError = useCallback(() => {
    setLoading(false);
    setError(true);
  }, []);

  const toggleSize = useCallback(() => {
    setActualSize((prev) => !prev);
  }, []);

  // Reset state when src changes
  useEffect(() => {
    setLoading(true);
    setError(false);
    setDimensions(null);
    setActualSize(false);
    setUserConfirmedLoad(false);
  }, [src]);

  // Too large — download only
  if (isTooLarge) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12 text-fg-muted">
        <div className="text-sm font-medium">File too large to preview</div>
        {fileSize != null && (
          <div className="text-xs">{formatFileSize(fileSize)}</div>
        )}
        <a
          href={src}
          download={fileName}
          className="px-4 py-2 text-sm font-medium rounded-md bg-accent-primary text-fg-on-accent no-underline hover:opacity-90"
        >
          Download
        </a>
      </div>
    );
  }

  // Large file — click to load
  if (isLargeFile && !userConfirmedLoad) {
    return (
      <div className="flex flex-col items-center justify-center gap-4 p-12 text-fg-muted">
        <div className="text-sm font-medium">Large image</div>
        {fileSize != null && (
          <div className="text-xs">{formatFileSize(fileSize)}</div>
        )}
        <button
          type="button"
          onClick={() => setUserConfirmedLoad(true)}
          className="px-4 py-2 text-sm font-medium rounded-md bg-accent-primary text-fg-on-accent border-none cursor-pointer hover:opacity-90"
        >
          Load preview
        </button>
      </div>
    );
  }

  return (
    <div className="flex flex-col h-full">
      {/* Metadata bar */}
      {(!loading || dimensions) && !error && (
        <div className="flex items-center gap-3 px-3 py-1.5 border-b border-border-default bg-surface text-xs text-fg-muted shrink-0">
          {dimensions && (
            <span>{dimensions.w} &times; {dimensions.h}</span>
          )}
          {fileSize != null && fileSize > 0 && (
            <span>{formatFileSize(fileSize)}</span>
          )}
          <button
            type="button"
            onClick={toggleSize}
            className="ml-auto px-2 py-0.5 text-[11px] font-medium rounded border border-border-default bg-transparent text-fg-muted cursor-pointer hover:text-fg-primary"
          >
            {actualSize ? 'Fit to panel' : 'Actual size (1:1)'}
          </button>
        </div>
      )}

      {/* Image area */}
      <div
        className="flex-1 min-h-0"
        style={{
          overflow: actualSize ? 'auto' : 'hidden',
          display: 'flex',
          alignItems: actualSize ? 'flex-start' : 'center',
          justifyContent: actualSize ? 'flex-start' : 'center',
          padding: loading ? 0 : 16,
        }}
      >
        {loading && !error && (
          <div className="flex justify-center p-8 w-full">
            <Spinner size="md" />
          </div>
        )}

        {error && (
          <div
            className="m-4 p-3 bg-danger-tint rounded-lg"
            style={{ fontSize: 'var(--sam-type-caption-size)', color: 'var(--sam-color-tn-red)' }}
          >
            Failed to load image
          </div>
        )}

        {shouldRender && (
          <img
            src={src}
            alt={fileName}
            onLoad={handleLoad}
            onError={handleError}
            onClick={toggleSize}
            style={{
              display: loading ? 'none' : 'block',
              maxWidth: actualSize ? 'none' : '100%',
              maxHeight: actualSize ? 'none' : '100%',
              objectFit: 'contain',
              cursor: 'pointer',
            }}
          />
        )}
      </div>
    </div>
  );
};
