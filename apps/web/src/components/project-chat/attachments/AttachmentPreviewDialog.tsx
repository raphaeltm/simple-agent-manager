/**
 * Full-screen (phone) or centred (desktop) viewer for a staged composer attachment. It shows the
 * local file, so it works before, during and after upload, and for files that failed or were too
 * large to upload.
 */
import {
  IconButton,
  paneClassName,
  SegmentedControl,
  useModalInteraction,
} from '@simple-agent-manager/ui';
import { AlertTriangle, ChevronLeft, ChevronRight, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatFileSize } from '../../../lib/file-utils';
import type { ProjectChatComposerAttachment } from '../ProjectChatComposer';
import type { AttachmentInfo } from './attachment-kind';
import { AttachmentPreviewFallback } from './AttachmentPreviewFallback';
import { AttachmentTextPreview } from './AttachmentTextPreview';
import { textMeta, useAttachmentInfo, useObjectUrl } from './useLocalFilePreview';

/** Stable stand-in while the composer closes a viewer whose attachment just went away. */
const EMPTY_FILE = new File([], '');

const CHECKERBOARD =
  'bg-[length:16px_16px] bg-[linear-gradient(45deg,rgb(128_128_128/0.14)_25%,transparent_25%,transparent_75%,rgb(128_128_128/0.14)_75%),linear-gradient(45deg,rgb(128_128_128/0.14)_25%,transparent_25%,transparent_75%,rgb(128_128_128/0.14)_75%)] [background-position:0_0,8px_8px]';

function ImagePreview({
  file,
  info,
  onDimensions,
}: {
  file: File;
  info: AttachmentInfo;
  onDimensions: (dimensions: string | null) => void;
}) {
  const url = useObjectUrl(file);
  const [failed, setFailed] = useState(false);
  const [zoom, setZoom] = useState<'fit' | 'actual'>('fit');
  if (failed) {
    return (
      <AttachmentPreviewFallback
        info={info}
        title="This image can't be shown in the browser"
        body="It may be a format your browser doesn't decode, or the file is damaged. It is still sent to the agent as-is."
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`relative min-h-0 flex-1 overflow-auto ${CHECKERBOARD}`}>
        {url && (
          <img
            src={url}
            alt={file.name}
            data-testid="attachment-image-preview"
            onLoad={(e) =>
              onDimensions(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)
            }
            onError={() => {
              setFailed(true);
              onDimensions(null);
            }}
            className={
              zoom === 'fit'
                ? 'absolute inset-0 m-auto max-h-full max-w-full object-contain'
                : 'block max-w-none'
            }
          />
        )}
      </div>
      <div className="flex shrink-0 justify-center border-t border-[var(--sam-hairline)] p-2">
        <SegmentedControl
          label="Image zoom"
          className="w-40"
          value={zoom}
          onChange={setZoom}
          options={[
            { value: 'fit', label: 'Fit' },
            { value: 'actual', label: '100%' },
          ]}
        />
      </div>
    </div>
  );
}

function VideoPreview({ file, info }: { file: File; info: AttachmentInfo }) {
  const url = useObjectUrl(file);
  const [failed, setFailed] = useState(false);
  if (failed) {
    return (
      <AttachmentPreviewFallback
        info={info}
        title="This video can't play in your browser"
        body="It is still sent to the agent as-is."
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center bg-black">
      {url && (
        // eslint-disable-next-line jsx-a11y/media-has-caption -- a user's own unsent upload has no caption track
        <video
          src={url}
          controls
          playsInline
          preload="metadata"
          aria-label={`Video ${file.name}`}
          data-testid="attachment-video-preview"
          className="block h-full w-full object-contain"
          onError={() => setFailed(true)}
        />
      )}
    </div>
  );
}

export interface AttachmentPreviewDialogProps {
  attachments: ProjectChatComposerAttachment[];
  index: number;
  onClose: () => void;
  onNavigate: (index: number) => void;
  onRemove?: (index: number) => void;
  /** Moves a whole paste back into the message box and drops the attachment. */
  onMoveToMessage?: (index: number, text: string) => void;
}

export function AttachmentPreviewDialog({
  attachments,
  index,
  onClose,
  onNavigate,
  onRemove,
  onMoveToMessage,
}: AttachmentPreviewDialogProps) {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const attachment = attachments[index];
  const count = attachments.length;
  const { info, stats } = useAttachmentInfo(attachment?.file ?? EMPTY_FILE);
  const [dimensions, setDimensions] = useState<{ file: File; value: string | null } | null>(null);

  useModalInteraction({ enabled: true, modalRef, onEscape: onClose });

  // Arrow keys page through attachments unless focus is in a field.
  useEffect(() => {
    if (count < 2) return;
    const onKey = (event: KeyboardEvent) => {
      const target = event.target;
      if (target instanceof Element && target.closest('input, textarea, select, video')) return;
      if (event.key === 'ArrowLeft') onNavigate((index - 1 + count) % count);
      if (event.key === 'ArrowRight') onNavigate((index + 1) % count);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [count, index, onNavigate]);

  if (!attachment) return null;
  const { file } = attachment;
  const size = formatFileSize(file.size);
  const meta = [
    info.typeLabel,
    dimensions?.file === file ? dimensions.value : null,
    info.kind === 'text' ? textMeta(stats, size) : size,
  ]
    .filter(Boolean)
    .join(' · ');

  const remove = () => {
    if (!onRemove) return;
    onRemove(index);
    // Stay in the viewer on the neighbour, like a photo gallery; close after the last one.
    if (count === 1) onClose();
    else onNavigate(index < count - 1 ? index : index - 1);
  };

  // Remounts the body when the shown file changes, including when a removal shifts the next
  // file into this index, so per-file state (zoom, decode failure, wrap) never carries over.
  const bodyKey = attachment.id ?? `${index}:${file.name}:${file.size}:${file.lastModified}`;
  let body;
  if (info.kind === 'image') {
    body = (
      <ImagePreview
        key={bodyKey}
        file={file}
        info={info}
        onDimensions={(value) => setDimensions({ file, value })}
      />
    );
  } else if (info.kind === 'video') {
    body = <VideoPreview key={bodyKey} file={file} info={info} />;
  } else if (info.kind === 'text') {
    body = (
      <AttachmentTextPreview
        key={bodyKey}
        file={file}
        info={info}
        stats={stats}
        onMoveToMessage={onMoveToMessage ? (text) => onMoveToMessage(index, text) : undefined}
      />
    );
  } else {
    body = (
      <AttachmentPreviewFallback
        info={info}
        title={info.typeLabel}
        body={`There's no preview for this type. It is sent to the agent as ${file.name} (${size}).`}
      />
    );
  }

  return createPortal(
    <div
      ref={modalRef}
      data-sam-modal-root=""
      role="dialog"
      aria-modal="true"
      aria-labelledby={titleId}
      tabIndex={-1}
      className="fixed inset-0 z-dialog-backdrop flex items-stretch justify-center sm:items-center sm:p-8"
    >
      {/* eslint-disable-next-line jsx-a11y/click-events-have-key-events, jsx-a11y/no-static-element-interactions -- scrim; Escape closes */}
      <div className="fixed inset-0 bg-[rgb(0_0_0/0.5)] backdrop-blur-sm" onClick={onClose} />
      {/* bg-page: a media viewer must be opaque, or the composer shows through the glass. */}
      <div
        data-testid="attachment-preview"
        className={`${paneClassName('overlay', { rounded: false })} relative flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden bg-page sm:h-[min(820px,calc(100dvh-4rem))] sm:max-w-[960px] sm:rounded-[var(--sam-radius-pane)]`}
      >
        <header className="flex shrink-0 items-start gap-2 border-b border-[var(--sam-hairline)] py-2 pl-4 pr-2 pt-[max(0.5rem,env(safe-area-inset-top))]">
          <div className="min-w-0 flex-1 py-1">
            <h2
              id={titleId}
              title={file.name}
              className="m-0 line-clamp-2 break-all text-[15px] font-semibold text-fg-primary"
            >
              {info.displayName}
            </h2>
            <p className="m-0 mt-0.5 truncate text-xs text-fg-muted">{meta}</p>
          </div>
          {onRemove && (
            <button
              type="button"
              onClick={remove}
              aria-label={`Remove ${file.name}`}
              className="flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--sam-radius-control)] border-0 bg-transparent px-2.5 text-[13px] text-[var(--sam-status-danger-fg)] hover:bg-[var(--sam-status-danger-bg)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
            >
              <Trash2 size={15} aria-hidden="true" />
              <span className="hidden sm:inline">Remove</span>
            </button>
          )}
          <IconButton label="Close preview" icon={<X size={18} />} onClick={onClose} />
        </header>

        {attachment.status === 'error' && (
          <div
            role="alert"
            className="flex shrink-0 items-center gap-2 bg-[var(--sam-status-danger-bg)] px-4 py-2 text-xs text-[var(--sam-status-danger-fg)]"
          >
            <AlertTriangle size={14} className="shrink-0" aria-hidden="true" />
            <span className="min-w-0 break-words">
              {(attachment.error ?? 'Upload failed').replace(/\.$/, '')}. Remove it to send your
              message.
            </span>
          </div>
        )}
        {(attachment.status === 'uploading' || attachment.status === 'pending') && (
          <div className="shrink-0 px-4 py-2 text-xs text-fg-muted">
            Uploading… {attachment.progress}%
          </div>
        )}

        {body}

        {count > 1 && (
          <footer className="flex shrink-0 items-center justify-between border-t border-[var(--sam-hairline)] px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
            <IconButton
              label="Previous attachment"
              icon={<ChevronLeft size={18} />}
              onClick={() => onNavigate((index - 1 + count) % count)}
            />
            <span className="text-xs tabular-nums text-fg-muted" aria-live="polite">
              {index + 1} of {count}
            </span>
            <IconButton
              label="Next attachment"
              icon={<ChevronRight size={18} />}
              onClick={() => onNavigate((index + 1) % count)}
            />
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}
