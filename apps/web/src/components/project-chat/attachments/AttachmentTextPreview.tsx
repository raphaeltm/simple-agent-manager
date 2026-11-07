import { SegmentedControl } from '@simple-agent-manager/ui';
import { PencilLine } from 'lucide-react';
import { useEffect, useState } from 'react';

import { formatFileSize } from '../../../lib/file-utils';
import {
  ATTACHMENT_PREVIEW_LINE_MAX_CHARS,
  ATTACHMENT_PREVIEW_TEXT_MAX_BYTES,
  ATTACHMENT_PREVIEW_TEXT_MAX_LINES,
  type AttachmentInfo,
  pluralLines,
} from './attachment-kind';
import { AttachmentPreviewFallback } from './AttachmentPreviewFallback';
import type { TextStats } from './useLocalFilePreview';

interface PreparedText {
  lines: string[];
  /** The read stopped at the byte cap. */
  bytesTruncated: boolean;
  /** At least one line was cut at the character cap. */
  lineClipped: boolean;
  /** Lines dropped by the line cap. */
  linesHidden: boolean;
}

/** Splits the capped read into the lines the viewer renders. Exported for tests. */
export function prepareTextPreview(value: string, fileSize: number): PreparedText {
  const all = value.split('\n');
  if (value.endsWith('\n')) all.pop();
  const bytesTruncated = fileSize > ATTACHMENT_PREVIEW_TEXT_MAX_BYTES;
  // A cut mid-file leaves a partial last line; drop it rather than show half a line, unless it
  // is the only line (minified JSON), where dropping it would show nothing.
  const readable = bytesTruncated && all.length > 1 ? all.slice(0, -1) : all;
  const shown = readable.slice(0, ATTACHMENT_PREVIEW_TEXT_MAX_LINES);
  let lineClipped = false;
  const lines = shown.map((line) => {
    if (line.length <= ATTACHMENT_PREVIEW_LINE_MAX_CHARS) return line;
    lineClipped = true;
    return line.slice(0, ATTACHMENT_PREVIEW_LINE_MAX_CHARS);
  });
  return { lines, bytesTruncated, lineClipped, linesHidden: readable.length > shown.length };
}

function truncationNote(prepared: PreparedText, stats: TextStats | null, size: number): string {
  const parts: string[] = [];
  if (prepared.linesHidden || prepared.bytesTruncated) {
    parts.push(
      `Showing the first ${pluralLines(prepared.lines.length)}${
        stats?.lines != null ? ` of ${stats.lines.toLocaleString('en-US')}` : ''
      }${
        prepared.bytesTruncated
          ? ` (${formatFileSize(ATTACHMENT_PREVIEW_TEXT_MAX_BYTES)} of ${formatFileSize(size)})`
          : ''
      }.`
    );
  }
  if (prepared.lineClipped) {
    parts.push(
      `Long lines are cut at ${ATTACHMENT_PREVIEW_LINE_MAX_CHARS.toLocaleString('en-US')} characters.`
    );
  }
  parts.push('The whole file is sent to the agent.');
  return parts.join(' ');
}

export function AttachmentTextPreview({
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
  const [read, setRead] = useState<{ file: File; value: string | null } | null>(null);
  const [wrap, setWrap] = useState(true);

  useEffect(() => {
    let cancelled = false;
    file
      .slice(0, ATTACHMENT_PREVIEW_TEXT_MAX_BYTES)
      .text()
      .then(
        (value) => {
          if (!cancelled) setRead({ file, value });
        },
        (err: unknown) => {
          console.warn('Attachment text preview read failed', { name: file.name, err });
          if (!cancelled) setRead({ file, value: null });
        }
      );
    return () => {
      cancelled = true;
    };
  }, [file]);

  const current = read?.file === file ? read : null;
  if (!current) return <div className="flex-1 p-4 text-sm text-fg-muted">Reading…</div>;
  if (current.value === null) {
    return (
      <AttachmentPreviewFallback
        info={info}
        title="This file couldn't be read"
        body="The browser couldn't open it. It may have been moved or changed since you attached it."
      />
    );
  }
  if (file.size === 0) {
    return (
      <AttachmentPreviewFallback info={info} title="This file is empty" body="It has no content to send." />
    );
  }

  const text = current.value;
  const prepared = prepareTextPreview(text, file.size);
  const truncated = prepared.bytesTruncated || prepared.lineClipped || prepared.linesHidden;
  const gutter = String(prepared.lines.length).length;

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-2 border-b border-[var(--sam-hairline)] px-3 py-2 text-xs text-fg-muted">
        <span>
          {stats?.lines != null
            ? `${pluralLines(stats.lines)} · ${(stats.chars ?? 0).toLocaleString('en-US')} characters`
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
        {/* Only a whole paste can go back into the message box; a capped read would lose text. */}
        {info.isPaste && onMoveToMessage && !prepared.bytesTruncated && (
          <button
            type="button"
            onClick={() => onMoveToMessage(text)}
            className="sam-raised flex h-[30px] cursor-pointer items-center gap-1.5 rounded-[var(--sam-radius-control)] border-0 px-2.5 text-[13px] text-fg-primary focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-focus-ring"
          >
            <PencilLine size={14} aria-hidden="true" />
            Edit in message
          </button>
        )}
      </div>
      {/* eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- a scrollable region must be keyboard-scrollable */}
      <div
        className="relative min-h-0 flex-1 overflow-auto"
        role="region"
        tabIndex={0}
        aria-label="File contents"
        data-testid="attachment-text-preview"
      >
        <div
          className={`grid font-mono text-xs leading-[18px] ${wrap ? '' : 'w-max min-w-full'}`}
          style={{ gridTemplateColumns: `${gutter + 2}ch 1fr` }}
        >
          {prepared.lines.map((line, i) => (
            <div key={i} className="contents">
              <span className="select-none bg-[var(--sam-hairline)] pr-2 text-right tabular-nums text-fg-muted">
                {i + 1}
              </span>
              <span
                className={`px-3 text-fg-primary ${
                  wrap ? 'whitespace-pre-wrap [overflow-wrap:anywhere]' : 'whitespace-pre'
                }`}
              >
                {line || ' '}
              </span>
            </div>
          ))}
        </div>
        {truncated && (
          <p className="m-0 border-t border-[var(--sam-hairline)] px-3 py-3 text-xs text-fg-muted">
            {truncationNote(prepared, stats, file.size)}
          </p>
        )}
      </div>
    </div>
  );
}
