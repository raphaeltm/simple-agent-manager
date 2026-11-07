/**
 * Three candidate designs for the attachment row above the composer. PROTOTYPE ONLY.
 *
 * A — Chips+: today's chip footprint, plus a 24px thumbnail / type icon.
 * B — Tiles: 64px square tiles (image crop, text snippet, or icon) in one scrolling row.
 * C — Cards: image tiles + wide file cards that name the file and its size/line count.
 *
 * In all three the body opens the preview and the remove control is a separate button,
 * so a tap meant for "show me" can never discard the file.
 */
import { AlertCircle, X } from 'lucide-react';
import { type ReactNode, useState } from 'react';

import { formatFileSize } from '../../lib/file-utils';
import {
  type AttachmentInfo,
  textMeta,
  type TextStats,
  useAttachmentInfo,
  useObjectUrl,
} from './attachment-kind';
import type { ProtoAttachment } from './mock-data';

export type StripVariant = 'chips' | 'tiles' | 'cards';

interface StripProps {
  attachments: ProtoAttachment[];
  onOpen: (id: string) => void;
  onRemove: (id: string) => void;
  disabled?: boolean;
}

interface ItemProps {
  attachment: ProtoAttachment;
  onOpen: () => void;
  onRemove: () => void;
  disabled?: boolean;
}

/** First non-blank line of a paste, so two pastes are distinguishable at a glance. */
function firstLine(stats: TextStats | null): string | null {
  const line = stats?.head.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 160) : null;
}

function previewLabel(a: ProtoAttachment, info: AttachmentInfo, stats: TextStats | null): string {
  const size = formatFileSize(a.file.size);
  const state =
    a.status === 'uploading'
      ? `, uploading ${a.progress}%`
      : a.status === 'error'
        ? `, upload failed: ${a.error ?? 'unknown error'}`
        : '';
  const meta = info.kind === 'text' ? textMeta(stats, size) : size;
  const name = info.isPaste ? 'Pasted text' : a.file.name;
  return `Preview ${name} — ${info.typeLabel}, ${meta}${state}`;
}

/** An <img> thumbnail that falls back to the type icon when the browser can't decode it. */
function Thumb({
  file,
  info,
  iconSize,
  className = '',
}: {
  file: File;
  info: AttachmentInfo;
  iconSize: number;
  className?: string;
}) {
  const url = useObjectUrl(info.kind === 'image' ? file : null);
  const [failed, setFailed] = useState(false);
  if (info.kind === 'image' && !failed) {
    return url ? (
      <img
        src={url}
        alt=""
        draggable={false}
        decoding="async"
        onError={() => setFailed(true)}
        className={`h-full w-full object-cover ${className}`}
      />
    ) : (
      <span className="block h-full w-full animate-pulse bg-[var(--sam-hairline)]" />
    );
  }
  const Icon = info.Icon;
  return (
    <span className="flex h-full w-full items-center justify-center" style={{ color: info.tone }}>
      <Icon size={iconSize} strokeWidth={1.75} aria-hidden="true" />
    </span>
  );
}

function RemoveButton({
  name,
  onRemove,
  disabled,
  className,
  size = 12,
}: {
  name: string;
  onRemove: () => void;
  disabled?: boolean;
  className: string;
  size?: number;
}) {
  return (
    <button
      type="button"
      disabled={disabled}
      onClick={onRemove}
      aria-label={`Remove ${name}`}
      title={`Remove ${name}`}
      className={`cursor-pointer border-0 focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-focus-ring disabled:cursor-not-allowed disabled:opacity-50 ${className}`}
    >
      <X size={size} strokeWidth={2.25} aria-hidden="true" />
    </button>
  );
}

/** Ring progress for tiles; a thin bar is used for chips. */
function TileStatus({ attachment }: { attachment: ProtoAttachment }) {
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
    // A tinted wash + centred icon reads as "failed" on any thumbnail, unlike a corner badge.
    return (
      <span className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--sam-status-danger-fg)_55%,transparent)] text-white">
        <AlertCircle size={22} strokeWidth={2.25} aria-hidden="true" />
      </span>
    );
  }
  return null;
}

/** Corner remove control for tiles/cards: small, high-contrast, outside the tap-to-preview area. */
const TILE_REMOVE =
  'absolute -right-1.5 -top-1.5 flex h-5 w-5 items-center justify-center rounded-full bg-fg-primary/85 text-[var(--sam-form-bg)] shadow-sm backdrop-blur-sm hover:bg-fg-primary';

const errorRing = (a: ProtoAttachment) =>
  a.status === 'error'
    ? 'border-[var(--sam-status-danger-fg)]'
    : 'border-[var(--sam-hairline)]';

// ---------------------------------------------------------------------------
// A — Chips+
// ---------------------------------------------------------------------------

function Chip({ attachment: a, onOpen, onRemove, disabled }: ItemProps) {
  const { info, stats } = useAttachmentInfo(a.file);
  const snippet = info.isPaste ? firstLine(stats) : null;
  const meta =
    a.status === 'uploading'
      ? `${a.progress}%`
      : info.kind === 'text'
        ? textMeta(stats, formatFileSize(a.file.size))
        : formatFileSize(a.file.size);
  return (
    <div
      role="listitem"
      className={`relative flex h-8 max-w-[260px] min-w-0 items-center overflow-hidden rounded-sm border bg-page text-xs ${errorRing(a)}`}
    >
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-label={previewLabel(a, info, stats)}
        className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-1.5 border-0 bg-transparent pl-1 pr-1 text-left focus-visible:outline-2 focus-visible:-outline-offset-2 focus-visible:outline-focus-ring"
      >
        <span className="h-6 w-6 shrink-0 overflow-hidden rounded-[4px] bg-[var(--sam-hairline)]">
          <Thumb file={a.file} info={info} iconSize={14} />
        </span>
        <span className={`truncate text-fg-primary ${snippet ? 'font-mono text-[11px]' : ''}`}>
          {snippet ?? info.displayName}
        </span>
        <span className="shrink-0 text-fg-muted">{meta}</span>
        {a.status === 'error' && <span className="shrink-0 text-danger">Failed</span>}
      </button>
      <RemoveButton
        name={info.displayName}
        onRemove={onRemove}
        disabled={disabled}
        className="mr-0.5 flex h-6 w-6 shrink-0 items-center justify-center rounded-[4px] bg-transparent text-fg-muted hover:text-fg-primary"
      />
      {a.status === 'uploading' && (
        <span
          className="absolute bottom-0 left-0 h-0.5 rounded-full bg-accent-emphasis transition-all"
          style={{ width: `${a.progress}%` }}
        />
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// B — Tiles
// ---------------------------------------------------------------------------

function TextSnippet({ stats, lines }: { stats: TextStats | null; lines: number }) {
  const head = (stats?.head ?? '')
    .split('\n')
    .slice(0, lines)
    .map((l) => l.slice(0, 60))
    .join('\n');
  return (
    <span data-intentional-clip className="block h-full w-full overflow-hidden whitespace-pre px-1.5 pt-1.5 text-left font-mono text-[6.5px] leading-[8.5px] text-fg-muted">
      {head || ' '}
    </span>
  );
}

function Tile({ attachment: a, onOpen, onRemove, disabled }: ItemProps) {
  const { info, stats } = useAttachmentInfo(a.file);
  let body: ReactNode;
  if (info.kind === 'image') {
    body = <Thumb file={a.file} info={info} iconSize={22} />;
  } else if (info.kind === 'text') {
    body = (
      <>
        <TextSnippet stats={stats} lines={7} />
        <span className="absolute inset-x-0 bottom-0 flex h-5 items-end bg-[linear-gradient(transparent,var(--sam-form-bg)_60%)] px-1.5 pb-0.5">
          <span className="truncate text-[9px] font-semibold tracking-wide text-fg-primary">
            {info.isPaste ? 'PASTED' : info.badge}
          </span>
        </span>
      </>
    );
  } else {
    const Icon = info.Icon;
    body = (
      <span className="flex h-full w-full flex-col items-center justify-center gap-0.5 px-1">
        <Icon size={20} strokeWidth={1.75} style={{ color: info.tone }} aria-hidden="true" />
        <span className="text-[9px] font-semibold tracking-wide" style={{ color: info.tone }}>
          {info.badge}
        </span>
        <span className="line-clamp-1 w-full break-all text-center text-[9px] leading-[11px] text-fg-muted">
          {a.file.name}
        </span>
      </span>
    );
  }
  return (
    <div role="listitem" className="relative shrink-0 snap-start">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-label={previewLabel(a, info, stats)}
        title={info.isPaste ? (firstLine(stats) ?? 'Pasted text') : a.file.name}
        className={`relative block h-16 w-16 cursor-pointer overflow-hidden rounded-[10px] border bg-[var(--sam-form-bg)] p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${errorRing(a)}`}
      >
        {body}
        <TileStatus attachment={a} />
      </button>
      <RemoveButton
        name={info.displayName}
        onRemove={onRemove}
        disabled={disabled}
        size={10}
        className={TILE_REMOVE}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// C — Cards
// ---------------------------------------------------------------------------

function Card({ attachment: a, onOpen, onRemove, disabled }: ItemProps) {
  const { info, stats } = useAttachmentInfo(a.file);
  if (info.kind === 'image') {
    return (
      <div role="listitem" className="relative shrink-0 snap-start">
        <button
          type="button"
          onClick={onOpen}
          aria-haspopup="dialog"
          aria-label={previewLabel(a, info, stats)}
          title={a.file.name}
          className={`relative block h-14 w-14 cursor-pointer overflow-hidden rounded-[10px] border bg-[var(--sam-form-bg)] p-0 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${errorRing(a)}`}
        >
          <Thumb file={a.file} info={info} iconSize={20} />
          <TileStatus attachment={a} />
        </button>
        <RemoveButton
          name={info.displayName}
          onRemove={onRemove}
          disabled={disabled}
          size={10}
          className={TILE_REMOVE}
        />
      </div>
    );
  }
  const snippet = info.isPaste ? firstLine(stats) : null;
  const size = formatFileSize(a.file.size);
  const meta =
    a.status === 'uploading'
      ? `Uploading ${a.progress}%`
      : a.status === 'error'
        ? (a.error ?? 'Upload failed')
        : info.kind === 'text'
          ? `${info.isPaste ? 'Pasted · ' : ''}${textMeta(stats, size)}`
          : `${info.badge} · ${size}`;
  const Icon = info.Icon;
  return (
    <div role="listitem" className="relative shrink-0 snap-start">
      <button
        type="button"
        onClick={onOpen}
        aria-haspopup="dialog"
        aria-label={previewLabel(a, info, stats)}
        title={a.file.name}
        className={`relative flex h-14 w-[212px] cursor-pointer items-center gap-2.5 overflow-hidden rounded-[10px] border bg-[var(--sam-form-bg)] py-0 pl-2 pr-3 text-left focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring ${errorRing(a)}`}
      >
        <span
          className="flex h-10 w-10 shrink-0 flex-col items-center justify-center rounded-[8px] bg-[var(--sam-hairline)]"
          style={{ color: info.tone }}
        >
          <Icon size={18} strokeWidth={1.75} aria-hidden="true" />
          <span className="text-[8px] font-bold leading-none tracking-wide">{info.badge}</span>
        </span>
        <span className="flex min-w-0 flex-col">
          <span className={`truncate text-[13px] text-fg-primary ${snippet ? 'font-mono text-[12px]' : 'font-medium'}`}>
            {snippet ?? info.displayName}
          </span>
          <span className={`truncate text-[11px] ${a.status === 'error' ? 'text-danger' : 'text-fg-muted'}`}>
            {meta}
          </span>
        </span>
        {a.status === 'uploading' && (
          <span
            className="absolute bottom-0 left-0 h-0.5 bg-accent-emphasis transition-all"
            style={{ width: `${a.progress}%` }}
          />
        )}
      </button>
      <RemoveButton
        name={info.displayName}
        onRemove={onRemove}
        disabled={disabled}
        size={10}
        className={TILE_REMOVE}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------

const ITEM: Record<StripVariant, (props: ItemProps) => ReactNode> = {
  chips: Chip,
  tiles: Tile,
  cards: Card,
};

export function AttachmentStrip({ variant, attachments, onOpen, onRemove, disabled }: StripProps & { variant: StripVariant }) {
  if (attachments.length === 0) return null;
  const Item = ITEM[variant];
  const scrollRow =
    'relative -mt-2 flex snap-x gap-2.5 overflow-x-auto overscroll-x-contain pb-1.5 pr-2 pt-2 [scrollbar-width:thin]';
  return (
    <div
      role="list"
      aria-label={`${attachments.length} attachment${attachments.length === 1 ? '' : 's'}`}
      data-testid={`attachment-strip-${variant}`}
      className={
        variant === 'chips'
          ? 'relative mb-2 flex max-h-[120px] flex-wrap gap-1.5 overflow-y-auto'
          : `${scrollRow} mb-2`
      }
    >
      {attachments.map((a) => (
        <Item
          key={a.id}
          attachment={a}
          onOpen={() => onOpen(a.id)}
          onRemove={() => onRemove(a.id)}
          disabled={disabled}
        />
      ))}
    </div>
  );
}
