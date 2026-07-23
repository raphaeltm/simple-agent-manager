import type { ToolCallItem } from '@simple-agent-manager/acp-client';
import { Spinner } from '@simple-agent-manager/ui';
import { FileWarning } from 'lucide-react';
import { type FC, useEffect, useMemo, useState } from 'react';

import { downloadLibraryFile, getLibraryFilePreviewUrl } from '../../../lib/api/library';
import {
  FILE_PREVIEW_INLINE_MAX_BYTES,
  formatFileSize,
  isHtmlMime,
  isMarkdownMime,
  isPreviewableImageMime,
} from '../../../lib/file-utils';
import { FilePreviewModal } from '../../library/FilePreviewModal';
import { type FileWithTags, FOCUS_RING, getFileIcon } from '../../library/types';
import { extractDocumentCardData } from './document-card-data';

/** Timeout for the inline markdown preview fetch (ms). Override via VITE_DOC_CARD_MD_FETCH_TIMEOUT_MS. */
const DEFAULT_DOC_CARD_MD_FETCH_TIMEOUT_MS = 15_000;
const MD_FETCH_TIMEOUT_MS = import.meta.env.VITE_DOC_CARD_MD_FETCH_TIMEOUT_MS
  ? parseInt(import.meta.env.VITE_DOC_CARD_MD_FETCH_TIMEOUT_MS, 10)
  : DEFAULT_DOC_CARD_MD_FETCH_TIMEOUT_MS;

export interface DocumentCardProps {
  item: ToolCallItem;
  /** Project the card belongs to. Required to build preview URLs / open the modal. */
  projectId?: string;
}

/** Human labels for the tool that produced the card. */
const TOOL_LABELS: Record<string, string> = {
  upload_to_library: 'Document added',
  replace_library_file: 'Document updated',
  display_from_library: 'Document',
};

/**
 * Renders a library document tool call (upload / replace / display_from_library)
 * as a rich card with a tiered inline preview:
 *   - image  → lazy-loaded thumbnail
 *   - markdown → clamped source preview with a fade
 *   - other  → icon card
 * Every tier degrades to the icon card on error/oversize/unknown type. Clicking
 * the card opens the full-screen FilePreviewModal.
 */
export const DocumentCard: FC<DocumentCardProps> = ({ item, projectId }) => {
  const data = useMemo(() => extractDocumentCardData(item), [item]);
  const [modalOpen, setModalOpen] = useState(false);
  const [imgFailed, setImgFailed] = useState(false);
  const [mdText, setMdText] = useState<string | null>(null);
  const [mdDeleted, setMdDeleted] = useState(false);

  const { state, fileId, fileName, mimeType, sizeBytes, caption, tool } = data;
  const label = TOOL_LABELS[tool] ?? 'Document';

  const canPreview = Boolean(projectId && fileId);
  const previewUrl = canPreview ? getLibraryFilePreviewUrl(projectId as string, fileId as string) : undefined;

  const isImage = Boolean(mimeType && isPreviewableImageMime(mimeType, fileName));
  const isMarkdown = Boolean(mimeType && isMarkdownMime(mimeType, fileName));
  const isHtml = Boolean(mimeType && isHtmlMime(mimeType, fileName));
  const withinInlineCap = sizeBytes === undefined || sizeBytes <= FILE_PREVIEW_INLINE_MAX_BYTES;

  const showImageTier = state === 'ready' && canPreview && isImage && withinInlineCap && !imgFailed;
  const showMarkdownTier = state === 'ready' && canPreview && isMarkdown && withinInlineCap && !mdDeleted;

  // Fetch markdown source for the clamped inline preview. Only visible/near-
  // visible cards mount (the chat list is virtualized), so this is effectively
  // lazy. A 404 means the file was deleted → tombstone.
  useEffect(() => {
    if (!showMarkdownTier || !previewUrl) return;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), MD_FETCH_TIMEOUT_MS);
    fetch(previewUrl, { credentials: 'include', signal: controller.signal })
      .then((resp) => {
        if (resp.status === 404) {
          setMdDeleted(true);
          return null;
        }
        if (!resp.ok) throw new Error(`preview ${resp.status}`);
        return resp.text();
      })
      .then((text) => {
        if (text !== null && !controller.signal.aborted) setMdText(text);
      })
      .catch(() => {
        // Network/timeout — fall back to the icon tier (leave mdText null).
      })
      .finally(() => clearTimeout(timer));
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [showMarkdownTier, previewUrl]);

  const openModal = () => {
    if (canPreview) setModalOpen(true);
  };

  // ── Tombstone: the referenced file is gone ────────────────────────────────
  if (state === 'tombstone' || mdDeleted) {
    return (
      <div
        className="glass-surface rounded-md border border-border-default px-3 py-2.5 flex items-center gap-2.5 my-1"
        role="note"
        aria-label="Document no longer available"
      >
        <FileWarning size={18} className="text-fg-muted shrink-0" aria-hidden="true" />
        <div className="min-w-0">
          <div className="text-sm text-fg-primary truncate">{fileName ?? 'Document'}</div>
          <div className="text-xs text-fg-muted">No longer in the library</div>
        </div>
      </div>
    );
  }

  // ── Pending: the tool is still running ────────────────────────────────────
  if (state === 'pending') {
    return (
      <div
        className="glass-surface rounded-md border border-border-default px-3 py-2.5 flex items-center gap-2.5 my-1"
        role="status"
        aria-label="Preparing document"
      >
        <Spinner size="sm" />
        <div className="text-sm text-fg-muted truncate min-w-0">
          Preparing {fileName ?? 'document'}…
        </div>
      </div>
    );
  }

  const clickable = canPreview && (state === 'ready');

  const Header = (
    <div className="flex items-center gap-2.5 min-w-0">
      <span className="shrink-0">{getFileIcon(mimeType ?? '')}</span>
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium text-fg-primary truncate" title={fileName}>
          {fileName ?? 'Document'}
        </div>
        <div className="text-xs text-fg-muted flex items-center gap-1.5">
          <span>{label}</span>
          {sizeBytes !== undefined && sizeBytes > 0 && (
            <>
              <span aria-hidden="true">·</span>
              <span>{formatFileSize(sizeBytes)}</span>
            </>
          )}
        </div>
      </div>
    </div>
  );

  const body = (
    <div className="flex flex-col gap-2 min-w-0">
      {Header}

      {showImageTier && previewUrl && (
        <img
          src={previewUrl}
          alt={fileName ?? 'Document preview'}
          loading="lazy"
          onError={() => setImgFailed(true)}
          className="rounded-md max-h-64 w-auto max-w-full object-contain self-start border border-border-default"
        />
      )}

      {showMarkdownTier && mdText !== null && (
        <div className="relative max-h-32 overflow-hidden rounded-md bg-surface-inset px-3 py-2">
          {/* aria-hidden: the source preview is decorative — the button's
              aria-label ("Open <file>") is the accessible name, and the full
              document is available in the modal. */}
          <pre
            aria-hidden="true"
            className="text-xs text-fg-secondary whitespace-pre-wrap break-words m-0 font-sans leading-relaxed"
          >
            {mdText}
          </pre>
          {/* Fade-out to signal truncation */}
          <div
            className="pointer-events-none absolute inset-x-0 bottom-0 h-8"
            style={{ background: 'linear-gradient(to bottom, transparent, var(--sam-glass-bg-surface))' }}
            aria-hidden="true"
          />
        </div>
      )}

      {caption && (
        <div className="text-xs text-fg-secondary break-words">{caption}</div>
      )}

      {isHtml && (
        <div className="text-xs text-fg-muted">Interactive · tap to open</div>
      )}
    </div>
  );

  return (
    <>
      <div className="my-1">
        {clickable ? (
          <button
            type="button"
            onClick={openModal}
            aria-label={`Open ${fileName ?? 'document'}`}
            className={`w-full text-left glass-surface rounded-md border border-border-default px-3 py-2.5 cursor-pointer hover:bg-surface-hover transition-colors ${FOCUS_RING}`}
          >
            {body}
          </button>
        ) : (
          <div className="glass-surface rounded-md border border-border-default px-3 py-2.5">
            {body}
          </div>
        )}
      </div>

      {modalOpen && canPreview && previewUrl && (
        <FilePreviewModal
          // The modal reads filename/mimeType/sizeBytes; the card metadata is
          // sufficient for its render (it fetches content from previewUrl).
          file={{
            filename: fileName ?? 'Document',
            mimeType: mimeType ?? 'application/octet-stream',
            sizeBytes: sizeBytes ?? 0,
          } as unknown as FileWithTags}
          previewUrl={previewUrl}
          onClose={() => setModalOpen(false)}
          onDownload={() => downloadLibraryFile(projectId as string, fileId as string)}
        />
      )}
    </>
  );
};
