/**
 * The attachment row above the chat composer: images as square thumbnails, everything else as a
 * card with a typed icon, its name (or a paste's first line) and its size or line count.
 *
 * The card body opens the preview; remove is a separate button, so a tap meant for "show me"
 * can never discard the file. The row scrolls sideways rather than wrapping, so twenty files
 * don't push the message box off a phone screen.
 */
import { AlertCircle, X } from 'lucide-react';
import { useState } from 'react';

import { formatFileSize } from '../../../lib/file-utils';
import type { ProjectChatComposerAttachment } from '../ProjectChatComposer';
import type { AttachmentInfo } from './attachment-kind';
import {
  firstLine,
  textMeta,
  type TextStats,
  useAttachmentInfo,
  useObjectUrl,
} from './useLocalFilePreview';

/** Above this many attachments the row gets a count + total size line. */
const SUMMARY_MIN_ATTACHMENTS = 4;

const REMOVE_BUTTON =
  'absolute -right-1.5 -top-1.5 flex h-5 w-5 cursor-pointer items-center justify-center rounded-full border-0 bg-fg-primary/85 text-[var(--sam-form-bg)] shadow-sm backdrop-blur-sm hover:bg-fg-primary focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50';

const TRIGGER =
  'relative cursor-pointer overflow-hidden rounded-[10px] border bg-[var(--sam-form-bg)] p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring';

function previewLabel(
  a: ProjectChatComposerAttachment,
  info: AttachmentInfo,
  stats: TextStats | null
): string {
  const size = formatFileSize(a.file.size);
  const meta = info.kind === 'text' ? textMeta(stats, size) : size;
  const state =
    a.status === 'uploading' || a.status === 'pending'
      ? `, uploading ${a.progress}%`
      : a.status === 'error'
        ? `, failed: ${a.error ?? 'upload failed'}`
        : '';
  return `Preview ${info.isPaste ? 'Pasted text' : a.file.name}, ${info.typeLabel}, ${meta}${state}`;
}

function UploadOverlay({ attachment }: { attachment: ProjectChatComposerAttachment }) {
  if (attachment.status === 'uploading' || attachment.status === 'pending') {
    const r = 13;
    const c = 2 * Math.PI * r;
    return (
      <span className="absolute inset-0 flex items-center justify-center bg-[rgb(0_0_0/0.58)] backdrop-blur-[1.5px]">
        <svg width="34" height="34" viewBox="0 0 34 34" aria-hidden="true">
          <circle cx="17" cy="17" r={r} fill="none" stroke="rgb(255 255 255/0.3)" strokeWidth="3" />
          <circle
            cx="17"
            cy="17"
            r={r}
            fill="none"
            stroke="white"
            strokeWidth="3"
            strokeLinecap="round"
            strokeDasharray={c}
            strokeDashoffset={c * (1 - attachment.progress / 100)}
            transform="rotate(-90 17 17)"
          />
        </svg>
        <span className="absolute text-[9px] font-semibold text-white">{attachment.progress}%</span>
      </span>
    );
  }
  if (attachment.status === 'error') {
    // A tinted wash with a centred icon reads as "failed" on any thumbnail; a corner badge doesn't.
    return (
      <span className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--sam-status-danger-fg)_55%,transparent)] text-white">
        <AlertCircle size={22} strokeWidth={2.25} aria-hidden="true" />
      </span>
    );
  }
  return null;
}

function ImageThumb({ file, info }: { file: File; info: AttachmentInfo }) {
  const url = useObjectUrl(file);
  const [failed, setFailed] = useState(false);
  if (failed) {
    const Icon = info.Icon;
    return (
      <span className="flex h-full w-full items-center justify-center" style={{ color: info.tone }}>
        <Icon size={20} strokeWidth={1.75} aria-hidden="true" />
      </span>
    );
  }
  return url ? (
    <img
      src={url}
      alt=""
      draggable={false}
      decoding="async"
      onError={() => setFailed(true)}
      className="h-full w-full object-cover"
    />
  ) : (
    <span className="block h-full w-full animate-pulse bg-[var(--sam-hairline)]" />
  );
}

interface ItemProps {
  attachment: ProjectChatComposerAttachment;
  onOpen: () => void;
  onRemove?: () => void;
  disabled: boolean;
}

function AttachmentItem({ attachment: a, onOpen, onRemove, disabled }: ItemProps) {
  const { info, stats } = useAttachmentInfo(a.file);
  const borderTone =
    a.status === 'error' ? 'border-[var(--sam-status-danger-fg)]' : 'border-[var(--sam-hairline)]';
  const trigger = {
    type: 'button' as const,
    onClick: onOpen,
    'aria-haspopup': 'dialog' as const,
    'aria-label': previewLabel(a, info, stats),
    title: a.file.name,
  };

  let body;
  if (info.kind === 'image') {
    body = (
      <button {...trigger} className={`${TRIGGER} block h-14 w-14 ${borderTone}`}>
        <ImageThumb file={a.file} info={info} />
        <UploadOverlay attachment={a} />
      </button>
    );
  } else {
    const snippet = info.isPaste ? firstLine(stats) : null;
    const size = formatFileSize(a.file.size);
    const meta =
      a.status === 'uploading' || a.status === 'pending'
        ? `Uploading ${a.progress}%`
        : a.status === 'error'
          ? (a.error ?? 'Upload failed')
          : info.kind === 'text'
            ? `${info.isPaste ? 'Pasted · ' : ''}${textMeta(stats, size)}`
            : `${info.badge} · ${size}`;
    const Icon = info.Icon;
    body = (
      <button
        {...trigger}
        className={`${TRIGGER} flex h-14 w-[212px] items-center gap-2.5 py-0 pl-2 pr-3 text-left ${borderTone}`}
      >
        <span
          className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-[8px] bg-[var(--sam-hairline)]"
          style={{ color: info.tone }}
        >
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="text-[8px] font-bold leading-none tracking-wide">{info.badge}</span>
        </span>
        <span className="flex min-w-0 flex-col">
          <span
            className={`truncate text-fg-primary ${snippet ? 'font-mono text-xs' : 'text-[13px] font-medium'}`}
          >
            {snippet ?? info.displayName}
          </span>
          <span
            className={`truncate text-[11px] ${a.status === 'error' ? 'text-danger' : 'text-fg-muted'}`}
          >
            {meta}
          </span>
        </span>
        {(a.status === 'uploading' || a.status === 'pending') && (
          <span
            className="absolute bottom-0 left-0 h-0.5 bg-accent-emphasis transition-all"
            style={{ width: `${a.progress}%` }}
          />
        )}
      </button>
    );
  }

  return (
    <li className="relative shrink-0 snap-start">
      {body}
      {onRemove && (
        <button
          type="button"
          disabled={disabled}
          onClick={onRemove}
          aria-label={`Remove ${a.file.name}`}
          title={`Remove ${a.file.name}`}
          className={REMOVE_BUTTON}
        >
          <X size={10} strokeWidth={2.5} aria-hidden="true" />
        </button>
      )}
    </li>
  );
}

export function ComposerAttachmentList({
  attachments,
  onOpen,
  onRemove,
  disabled,
}: {
  attachments: ProjectChatComposerAttachment[];
  onOpen: (index: number) => void;
  onRemove?: (index: number) => void;
  disabled: boolean;
}) {
  if (attachments.length === 0) return null;
  const totalBytes = attachments.reduce((sum, a) => sum + a.file.size, 0);
  return (
    <div className="mb-2">
      {attachments.length >= SUMMARY_MIN_ATTACHMENTS && (
        <p className="m-0 mb-1 px-0.5 text-xs text-fg-muted">
          {attachments.length} attachments · {formatFileSize(totalBytes)}
        </p>
      )}
      {/* pt/pr leave room for the corner remove buttons inside the scroller's clip. */}
      <ul
        aria-label={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
        data-testid="composer-attachments"
        className="relative -mt-2 flex list-none snap-x gap-2.5 overflow-x-auto overscroll-x-contain pb-1.5 pl-0 pr-2 pt-2 [scrollbar-width:thin]"
      >
        {attachments.map((attachment, index) => (
          <AttachmentItem
            key={attachment.id ?? `${attachment.file.name}-${index}`}
            attachment={attachment}
            onOpen={() => onOpen(index)}
            onRemove={onRemove ? () => onRemove(index) : undefined}
            disabled={disabled}
          />
        ))}
      </ul>
    </div>
  );
}
