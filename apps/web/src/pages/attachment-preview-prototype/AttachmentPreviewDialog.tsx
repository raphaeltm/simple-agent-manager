/**
 * The preview opened by tapping any attachment, shared by all three strip variants.
 * Images: fit / actual-size viewer on a checkerboard. Text: line-numbered viewer with
 * wrap toggle and a capped read. Everything else: an identity card. PROTOTYPE ONLY.
 */
import { IconButton, paneClassName, SegmentedControl, useModalInteraction } from '@simple-agent-manager/ui';
import { AlertTriangle, ChevronLeft, ChevronRight, PencilLine, Trash2, X } from 'lucide-react';
import { useEffect, useId, useRef, useState } from 'react';
import { createPortal } from 'react-dom';

import { formatFileSize } from '../../lib/file-utils';
import {
  type AttachmentInfo,
  DEFAULT_TEXT_PREVIEW_BYTES,
  DEFAULT_TEXT_PREVIEW_LINE_CHARS,
  DEFAULT_TEXT_PREVIEW_LINES,
  formatCount,
  textMeta,
  type TextStats,
  useAttachmentInfo,
  useObjectUrl,
} from './attachment-kind';
import type { ProtoAttachment } from './mock-data';

interface Props {
  attachments: ProtoAttachment[];
  openId: string;
  onClose: () => void;
  onNavigate: (id: string) => void;
  onRemove: (id: string) => void;
  onMoveToMessage: (id: string, text: string) => void;
}

/** Stable placeholder so the hook's effect doesn't re-run while the dialog closes. */
const EMPTY_FILE = new File([], 'empty');

const CHECKERBOARD =
  'bg-[length:16px_16px] bg-[linear-gradient(45deg,rgb(128_128_128/0.14)_25%,transparent_25%,transparent_75%,rgb(128_128_128/0.14)_75%),linear-gradient(45deg,rgb(128_128_128/0.14)_25%,transparent_25%,transparent_75%,rgb(128_128_128/0.14)_75%)] [background-position:0_0,8px_8px]';

function ImageBody({
  file,
  onDimensions,
}: {
  file: File;
  onDimensions: (d: string | null) => void;
}) {
  const url = useObjectUrl(file);
  const [failed, setFailed] = useState(false);
  const [fit, setFit] = useState<'fit' | 'actual'>('fit');
  if (failed) {
    return (
      <Unpreviewable
        title="This image can't be shown in the browser"
        body="It may be a format your browser doesn't decode (HEIC, TIFF) or the file is damaged. It will still be sent to the agent as-is."
      />
    );
  }
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`relative min-h-0 flex-1 overflow-auto ${CHECKERBOARD}`} data-testid="image-viewport">
        {url && (
          <img
            src={url}
            alt={file.name}
            onLoad={(e) => onDimensions(`${e.currentTarget.naturalWidth}×${e.currentTarget.naturalHeight}`)}
            onError={() => {
              setFailed(true);
              onDimensions(null);
            }}
            className={
              fit === 'fit'
                ? 'absolute inset-0 m-auto max-h-full max-w-full object-contain [image-rendering:auto]'
                : 'block max-w-none [image-rendering:pixelated]'
            }
          />
        )}
      </div>
      <div className="flex shrink-0 justify-center border-t border-[var(--sam-hairline)] p-2">
        <SegmentedControl
          label="Image zoom"
          className="w-40"
          value={fit}
          onChange={setFit}
          options={[
            { value: 'fit', label: 'Fit' },
            { value: 'actual', label: '100%' },
          ]}
        />
      </div>
    </div>
  );
}

function TextBody({
  file,
  info,
  stats,
  onMoveToMessage,
}: {
  file: File;
  info: AttachmentInfo;
  stats: TextStats | null;
  onMoveToMessage?: (text: string) => void;
}) {
  const [text, setText] = useState<{ file: File; value: string } | null>(null);
  const [wrap, setWrap] = useState(true);
  useEffect(() => {
    let cancelled = false;
    void file
      .slice(0, DEFAULT_TEXT_PREVIEW_BYTES)
      .text()
      .then((value) => {
        if (!cancelled) setText({ file, value });
      });
    return () => {
      cancelled = true;
    };
  }, [file]);

  const value = text?.file === file ? text.value : null;
  if (value === null) {
    return <div className="flex-1 p-4 text-sm text-fg-muted">Reading…</div>;
  }
  if (file.size === 0) {
    return <Unpreviewable title="This file is empty" body="It has no content. You may want to remove it." />;
  }
  const allLines = value.split('\n');
  const bytesTruncated = file.size > DEFAULT_TEXT_PREVIEW_BYTES;
  // A cut mid-file leaves a partial last line; drop it rather than show half a line —
  // unless it is the only line (minified JSON), where dropping it would show nothing.
  const readable = bytesTruncated && allLines.length > 1 ? allLines.slice(0, -1) : allLines;
  const shown = readable
    .slice(0, DEFAULT_TEXT_PREVIEW_LINES)
    .map((line) =>
      line.length > DEFAULT_TEXT_PREVIEW_LINE_CHARS
        ? `${line.slice(0, DEFAULT_TEXT_PREVIEW_LINE_CHARS)} … (line continues)`
        : line
    );
  const linesClipped = readable.some((line) => line.length > DEFAULT_TEXT_PREVIEW_LINE_CHARS);
  const truncated = bytesTruncated || linesClipped || readable.length > shown.length;
  const gutter = String(shown.length).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--sam-hairline)] px-3 py-2 text-xs text-fg-muted">
        <span>
          {stats?.lines != null
            ? `${formatCount(stats.lines)} ${stats.lines === 1 ? 'line' : 'lines'} · ${formatCount(stats.chars ?? 0)} characters`
            : formatFileSize(file.size)}
        </span>
        <span className="flex-1" />
        <SegmentedControl
          label="Line wrapping"
          className="w-44"
          value={wrap ? 'wrap' : 'nowrap'}
          onChange={(v) => setWrap(v === 'wrap')}
          options={[
            { value: 'wrap', label: 'Wrap' },
            { value: 'nowrap', label: 'No wrap' },
          ]}
        />
        {info.isPaste && onMoveToMessage && !bytesTruncated && (
          <button
            type="button"
            onClick={() => onMoveToMessage(value)}
            className="sam-raised flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[var(--sam-radius-control)] border-0 px-2.5 text-[13px] text-fg-primary"
          >
            <PencilLine size={14} aria-hidden="true" />
            Edit in message
          </button>
        )}
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- scrollable region must be keyboard-scrollable */}
      <div className="relative min-h-0 flex-1 overflow-auto" role="region" tabIndex={0} aria-label="File contents">
        <div
          className={`grid font-mono text-[12px] leading-[18px] ${wrap ? '' : 'w-max min-w-full'}`}
          style={{ gridTemplateColumns: `${gutter + 2}ch 1fr` }}
        >
          {shown.map((line, i) => (
            <div key={i} className="contents">
              <span className="select-none bg-[var(--sam-hairline)] pr-2 text-right text-fg-muted/70 tabular-nums">
                {i + 1}
              </span>
              <span
                className={`px-3 text-fg-primary ${wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'}`}
              >
                {line || ' '}
              </span>
            </div>
          ))}
        </div>
        {truncated && (
          <p className="m-0 border-t border-[var(--sam-hairline)] px-3 py-3 text-xs text-fg-muted">
            {shown.length === 1 && linesClipped
              ? `Showing the first ${formatCount(DEFAULT_TEXT_PREVIEW_LINE_CHARS)} characters of a ${formatCount(stats?.chars ?? 0)}-character line`
              : `Showing the first ${formatCount(shown.length)}${stats?.lines != null ? ` of ${formatCount(stats.lines)}` : ''} lines`}
            {bytesTruncated ? ` (${formatFileSize(DEFAULT_TEXT_PREVIEW_BYTES)} of ${formatFileSize(file.size)})` : ''}.
            The whole file is sent to the agent.
          </p>
        )}
      </div>
    </div>
  );
}

function Unpreviewable({ title, body, info }: { title: string; body: string; info?: AttachmentInfo }) {
  const Icon = info?.Icon;
  return (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 p-6 text-center">
      {Icon ? (
        <span
          className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-[18px] bg-[var(--sam-hairline)]"
          style={{ color: info.tone }}
        >
          <Icon size={34} strokeWidth={1.5} aria-hidden="true" />
          <span className="text-[11px] font-bold tracking-wide">{info.badge}</span>
        </span>
      ) : (
        <AlertTriangle size={28} className="text-fg-muted" aria-hidden="true" />
      )}
      <p className="m-0 text-sm font-medium text-fg-primary">{title}</p>
      <p className="m-0 max-w-sm text-sm text-fg-muted">{body}</p>
    </div>
  );
}

export function AttachmentPreviewDialog({
  attachments,
  openId,
  onClose,
  onNavigate,
  onRemove,
  onMoveToMessage,
}: Props) {
  const modalRef = useRef<HTMLDivElement>(null);
  const titleId = useId();
  const index = attachments.findIndex((a) => a.id === openId);
  const attachment = attachments[index];
  const { info, stats } = useAttachmentInfo(attachment?.file ?? EMPTY_FILE);
  const [dims, setDims] = useState<{ id: string; value: string | null } | null>(null);

  useModalInteraction({ enabled: true, modalRef, onEscape: onClose });

  const go = (delta: number) => {
    const next = attachments[(index + delta + attachments.length) % attachments.length];
    if (next) onNavigate(next.id);
  };

  // Arrow keys page through attachments, unless focus is in a field.
  useEffect(() => {
    if (attachments.length < 2) return;
    const onKey = (e: KeyboardEvent) => {
      if ((e.target as HTMLElement | null)?.closest('input, textarea, select')) return;
      if (e.key === 'ArrowLeft') go(-1);
      if (e.key === 'ArrowRight') go(1);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  });

  useEffect(() => {
    if (!attachment) onClose();
  }, [attachment, onClose]);
  if (!attachment) return null;

  const a = attachment;
  const size = formatFileSize(a.file.size);
  const dimension = dims?.id === a.id ? dims.value : null;
  const meta = [
    info.typeLabel,
    dimension,
    info.kind === 'text' ? textMeta(stats, size) : size,
  ]
    .filter(Boolean)
    .join(' · ');

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
      <div
        className={`${paneClassName('overlay', { rounded: false })} relative flex h-[100dvh] w-full min-w-0 flex-col overflow-hidden bg-page sm:h-[min(820px,calc(100dvh-4rem))] sm:max-w-[960px] sm:rounded-[var(--sam-radius-pane)]`}
        data-testid="attachment-preview"
      >
        <header className="flex shrink-0 items-start gap-2 border-b border-[var(--sam-hairline)] py-2 pl-4 pr-2">
          <div className="min-w-0 flex-1 py-1">
            <h2 id={titleId} title={a.file.name} className="m-0 line-clamp-2 break-all text-[15px] font-semibold text-fg-primary">
              {info.displayName}
            </h2>
            <p className="m-0 mt-0.5 truncate text-xs text-fg-muted">{meta}</p>
          </div>
          <button
            type="button"
            onClick={() => {
              // Stay in the viewer on the neighbour, like a photo gallery; close on the last one.
              const next = attachments[index + 1] ?? attachments[index - 1];
              onRemove(a.id);
              if (next) onNavigate(next.id);
            }}
            className="flex h-11 shrink-0 cursor-pointer items-center gap-1.5 rounded-[var(--sam-radius-control)] border-0 bg-transparent px-2.5 text-[13px] text-[var(--sam-status-danger-fg)] hover:bg-[var(--sam-status-danger-bg)]"
          >
            <Trash2 size={15} aria-hidden="true" />
            <span className="hidden sm:inline">Remove</span>
            <span className="sr-only sm:hidden">Remove attachment</span>
          </button>
          <IconButton label="Close preview" icon={<X size={18} />} onClick={onClose} />
        </header>

        {a.status === 'error' && (
          <div role="alert" className="flex shrink-0 items-center gap-2 bg-[var(--sam-status-danger-bg)] px-4 py-2 text-xs text-[var(--sam-status-danger-fg)]">
            <AlertTriangle size={14} aria-hidden="true" />
            <span className="min-w-0 break-words">{a.error ?? 'Upload failed'}</span>
          </div>
        )}
        {a.status === 'uploading' && (
          <div className="shrink-0 px-4 py-2 text-xs text-fg-muted">Uploading… {a.progress}%</div>
        )}

        {info.kind === 'image' ? (
          <ImageBody key={a.id} file={a.file} onDimensions={(value) => setDims({ id: a.id, value })} />
        ) : info.kind === 'text' ? (
          <TextBody
            key={a.id}
            file={a.file}
            info={info}
            stats={stats}
            onMoveToMessage={(text) => onMoveToMessage(a.id, text)}
          />
        ) : (
          <Unpreviewable
            info={info}
            title={info.typeLabel}
            body={`No preview for this type. It will be uploaded to the workspace as ${a.file.name} (${size}).`}
          />
        )}

        {attachments.length > 1 && (
          <footer className="flex shrink-0 items-center justify-between border-t border-[var(--sam-hairline)] px-2 py-1.5 pb-[max(0.375rem,env(safe-area-inset-bottom))]">
            <IconButton label="Previous attachment" icon={<ChevronLeft size={18} />} onClick={() => go(-1)} />
            <span className="text-xs tabular-nums text-fg-muted" aria-live="polite">
              {index + 1} of {attachments.length}
            </span>
            <IconButton label="Next attachment" icon={<ChevronRight size={18} />} onClick={() => go(1)} />
          </footer>
        )}
      </div>
    </div>,
    document.body
  );
}
