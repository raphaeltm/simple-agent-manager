import { Button, Spinner } from '@simple-agent-manager/ui';
import { AlertTriangle, Download } from 'lucide-react';
import { type RefObject, useEffect, useState } from 'react';

import {
  FILE_PREVIEW_LOAD_MAX_BYTES,
  isHtmlMime,
  isMarkdownMime,
  isPdfMime,
  isPreviewableImageMime,
  isVideoMime,
} from '../../lib/file-utils';
import { RenderedMarkdown, SyntaxHighlightedCode } from '../MarkdownRenderer';
import { ImageViewer } from '../shared-file-viewer/ImageViewer';
import { InteractiveHtmlPreview } from './InteractiveHtmlPreview';
import type { FileWithTags } from './types';

/** Default timeout for PDF iframe loading before showing error state (ms). */
const DEFAULT_PDF_LOAD_TIMEOUT_MS = 15_000;
const PDF_LOAD_TIMEOUT_MS = import.meta.env.VITE_PDF_LOAD_TIMEOUT_MS
  ? parseInt(import.meta.env.VITE_PDF_LOAD_TIMEOUT_MS, 10)
  : DEFAULT_PDF_LOAD_TIMEOUT_MS;

export type PreviewKind = 'image' | 'video' | 'pdf' | 'markdown' | 'html' | 'none';

/**
 * Which viewer a file opens in. Pass the filename so an octet-stream/empty stored type (agent
 * uploads) still resolves to its real previewable type from the extension.
 */
export function previewKindOf(file: Pick<FileWithTags, 'mimeType' | 'filename'>): PreviewKind {
  if (isPreviewableImageMime(file.mimeType, file.filename)) return 'image';
  if (isVideoMime(file.mimeType, file.filename)) return 'video';
  if (isPdfMime(file.mimeType, file.filename)) return 'pdf';
  if (isMarkdownMime(file.mimeType, file.filename)) return 'markdown';
  if (isHtmlMime(file.mimeType, file.filename)) return 'html';
  return 'none';
}

/** The preview API refuses anything above the load ceiling, so those files are download-only. */
export function isTooLargeToPreview(kind: PreviewKind, sizeBytes: number): boolean {
  return (kind === 'html' || kind === 'video') && sizeBytes > FILE_PREVIEW_LOAD_MAX_BYTES;
}

/** Every state where the artifact cannot be shown says why and offers the download instead. */
function PreviewFallback({ message, onDownload }: { message: string; onDownload: () => void }) {
  return (
    <div className="flex h-full min-h-[40vh] flex-col items-center justify-center gap-3 p-8 text-center">
      <AlertTriangle size={28} className="text-fg-muted" aria-hidden="true" />
      <p className="m-0 max-w-sm text-sm text-fg-muted">{message}</p>
      <Button variant="raised" size="sm" onClick={onDownload}>
        <Download size={14} aria-hidden="true" />
        Download
      </Button>
    </div>
  );
}

function VideoPreview({
  src,
  filename,
  onDownload,
}: {
  src: string;
  filename: string;
  onDownload: () => void;
}) {
  const [failed, setFailed] = useState(false);
  // A new file is a new chance to play.
  useEffect(() => setFailed(false), [src]);
  if (failed) {
    return (
      <PreviewFallback
        message="This video can't play in your browser. Download it to watch."
        onDownload={onDownload}
      />
    );
  }
  return (
    <div className="flex h-full min-h-0 items-center justify-center">
      {/* No `crossOrigin`: like the image viewer's <img>, the request carries the session cookie
          to the API, which answers byte ranges so the player can seek. */}
      {/* eslint-disable-next-line jsx-a11y/media-has-caption -- a library file is a lone video
          upload with no caption file to attach; there is no track to point at. */}
      <video
        src={src}
        controls
        playsInline
        preload="metadata"
        aria-label={`Video ${filename}`}
        data-testid="video-preview"
        className="block h-full w-full object-contain"
        onError={() => setFailed(true)}
      />
    </div>
  );
}

function PdfPreview({
  src,
  filename,
  onDownload,
}: {
  src: string;
  filename: string;
  onDownload: () => void;
}) {
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState(false);

  useEffect(() => {
    if (!loading) return;
    const timer = setTimeout(() => {
      setLoading(false);
      setError(true);
    }, PDF_LOAD_TIMEOUT_MS);
    return () => clearTimeout(timer);
  }, [loading]);

  if (error) {
    return (
      <PreviewFallback
        message="Unable to load PDF preview. Try downloading the file instead."
        onDownload={onDownload}
      />
    );
  }
  return (
    <div className="relative h-full min-h-[60vh]">
      {loading && (
        <div className="absolute inset-0 flex items-center justify-center">
          <Spinner size="md" />
        </div>
      )}
      {/* No `sandbox`: Chromium refuses to render a PDF inside any sandboxed frame. The preview
          response keeps this frame inert instead: it is served as application/pdf with nosniff,
          only after the bytes are checked to be a PDF, under a CSP that forbids script
          (apps/api/src/services/file-serving-policy.ts). */}
      <iframe
        src={src}
        title={`Preview of ${filename}`}
        className="h-full min-h-[60vh] w-full border-none"
        onLoad={() => setLoading(false)}
        onError={() => {
          setLoading(false);
          setError(true);
        }}
      />
    </div>
  );
}

export interface FilePreviewContentProps {
  file: FileWithTags;
  kind: PreviewKind;
  previewUrl: string;
  onDownload: () => void;
  markdown: {
    mode: 'rendered' | 'source';
    content: string | null;
    loading: boolean;
    error: string | null;
    bodyRef: RefObject<HTMLDivElement | null>;
  };
  html: {
    mode: 'preview' | 'source';
    source: string | null;
    loading: boolean;
    error: string | null;
  };
}

/** The artifact itself, in the viewer that fits its type. */
export function FilePreviewContent({
  file,
  kind,
  previewUrl,
  onDownload,
  markdown,
  html,
}: FilePreviewContentProps) {
  if (isTooLargeToPreview(kind, file.sizeBytes)) {
    return (
      <PreviewFallback
        message="This file is too large to preview. Download it to view the contents."
        onDownload={onDownload}
      />
    );
  }

  switch (kind) {
    case 'image':
      return <ImageViewer src={previewUrl} fileName={file.filename} fileSize={file.sizeBytes} />;
    case 'video':
      return <VideoPreview src={previewUrl} filename={file.filename} onDownload={onDownload} />;
    case 'pdf':
      return <PdfPreview src={previewUrl} filename={file.filename} onDownload={onDownload} />;
    case 'markdown':
      if (markdown.error && !markdown.loading) {
        return (
          <PreviewFallback
            message="Unable to load markdown preview. Try downloading the file instead."
            onDownload={onDownload}
          />
        );
      }
      if (markdown.loading || markdown.content === null) {
        return (
          <div className="flex items-center justify-center py-12">
            <Spinner size="md" />
          </div>
        );
      }
      return markdown.mode === 'rendered' ? (
        <div ref={markdown.bodyRef} data-comment-anchor={file.id}>
          <RenderedMarkdown content={markdown.content} />
        </div>
      ) : (
        <div className="p-4">
          <SyntaxHighlightedCode content={markdown.content} language="markdown" />
        </div>
      );
    case 'html':
      if (html.mode === 'preview') return <InteractiveHtmlPreview file={file} />;
      return (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          {html.loading && html.source === null && (
            <div className="flex items-center justify-center py-12">
              <Spinner size="md" />
            </div>
          )}
          {html.error && html.source === null && (
            <p role="alert" className="text-sm text-fg-muted">
              Unable to load the HTML source. Try downloading the file instead.
            </p>
          )}
          {html.source !== null && (
            <SyntaxHighlightedCode content={html.source} language="markup" />
          )}
        </div>
      );
    case 'none':
      return (
        <PreviewFallback
          message="There's no preview for this file type. Download it to open it."
          onDownload={onDownload}
        />
      );
  }
}
