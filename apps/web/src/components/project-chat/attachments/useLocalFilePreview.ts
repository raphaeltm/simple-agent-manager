import { useEffect, useState } from 'react';

import {
  ATTACHMENT_LINE_COUNT_MAX_BYTES,
  ATTACHMENT_SNIFF_BYTES,
  type AttachmentInfo,
  countLines,
  describeAttachment,
  looksLikeText,
  pluralLines,
} from './attachment-kind';

/**
 * A `blob:` URL for a local file, revoked when the file changes or the consumer unmounts.
 * Each consumer owns its own URL, so a thumbnail unmounting never breaks an open viewer.
 */
export function useObjectUrl(file: File | null): string | null {
  const [state, setState] = useState<{ file: File; url: string } | null>(null);
  useEffect(() => {
    if (!file) return;
    const url = URL.createObjectURL(file);
    setState({ file, url });
    return () => URL.revokeObjectURL(url);
  }, [file]);
  return state && state.file === file ? state.url : null;
}

export interface TextStats {
  /** The first `ATTACHMENT_SNIFF_BYTES` of the file, decoded. */
  head: string;
  /** Exact line count, or null when the file is too large to count. */
  lines: number | null;
  chars: number | null;
}

/**
 * Describes a local file and, for text and unknown types, reads its head once to sniff
 * text-vs-binary and to give the card its first line and line count.
 */
export function useAttachmentInfo(file: File): { info: AttachmentInfo; stats: TextStats | null } {
  const [sniffed, setSniffed] = useState<{ file: File; text: boolean; stats: TextStats } | null>(
    null
  );

  useEffect(() => {
    const base = describeAttachment(file);
    // Only text, and binaries of unknown type that might be text, are worth reading.
    if (base.kind !== 'text' && !base.sniffable) return;
    let cancelled = false;
    void (async () => {
      try {
        const head = await file.slice(0, ATTACHMENT_SNIFF_BYTES).text();
        const isText = looksLikeText(head);
        let lines: number | null = null;
        let chars: number | null = null;
        if (isText && file.size <= ATTACHMENT_LINE_COUNT_MAX_BYTES) {
          const all = file.size <= ATTACHMENT_SNIFF_BYTES ? head : await file.text();
          chars = all.length;
          lines = countLines(all);
        }
        if (!cancelled) setSniffed({ file, text: isText, stats: { head, lines, chars } });
      } catch (err) {
        // An unreadable file keeps its type-based card; the preview reports the failure.
        console.warn('Attachment head read failed', { name: file.name, size: file.size, err });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const current = sniffed?.file === file ? sniffed : null;
  const info = describeAttachment(file, current?.text ?? false);
  return { info, stats: info.kind === 'text' ? (current?.stats ?? null) : null };
}

/** First non-blank line of a text file, so two pastes can be told apart at a glance. */
export function firstLine(stats: TextStats | null): string | null {
  const line = stats?.head.split('\n').find((l) => l.trim().length > 0);
  return line ? line.trim().slice(0, 160) : null;
}

/** "900 lines · 141 KB" for a counted text file, else just the size. */
export function textMeta(stats: TextStats | null, size: string): string {
  if (!stats || stats.lines === null) return size;
  if (stats.lines === 0) return 'Empty';
  return `${pluralLines(stats.lines)} · ${size}`;
}
