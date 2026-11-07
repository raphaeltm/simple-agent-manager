/**
 * Classifies a composer attachment into image / text / other and supplies the icon,
 * short type badge and human label each variant renders. PROTOTYPE ONLY.
 */
import {
  File as FileIcon,
  FileArchive,
  FileAudio,
  FileCode,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideo,
  type LucideIcon,
} from 'lucide-react';
import { useEffect, useState } from 'react';

/** Bytes read to decide whether an unknown file is text, and to draw the tile snippet. */
export const DEFAULT_SNIFF_BYTES = 4096;
/** Upper bound on bytes read into the text preview. Larger files show a truncation note. */
export const DEFAULT_TEXT_PREVIEW_BYTES = 256 * 1024;
/** Upper bound on lines rendered in the text preview (DOM cost). */
export const DEFAULT_TEXT_PREVIEW_LINES = 2000;
/** Characters rendered per line; minified JSON can be one 300 KB line. */
export const DEFAULT_TEXT_PREVIEW_LINE_CHARS = 20_000;
/** Files up to this size are read fully so the line count is exact. */
export const DEFAULT_EXACT_LINE_COUNT_BYTES = 8 * 1024 * 1024;

export type AttachmentKind = 'image' | 'text' | 'other';
type Category =
  | 'image'
  | 'text'
  | 'code'
  | 'data'
  | 'sheet'
  | 'pdf'
  | 'archive'
  | 'video'
  | 'audio'
  | 'binary';

const PASTED_NAME = /^pasted-\d+\.txt$/;

/** Rendered by <img>. SVG is safe in <img> (scripts never run there), unlike an iframe. */
const RENDERABLE_IMAGE = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'image/bmp',
  'image/svg+xml',
]);

const EXT_CATEGORY: Record<string, Category> = {
  txt: 'text', md: 'text', markdown: 'text', log: 'text', rst: 'text',
  ts: 'code', tsx: 'code', js: 'code', jsx: 'code', go: 'code', py: 'code', rs: 'code',
  sh: 'code', css: 'code', html: 'code', sql: 'code', toml: 'code', yaml: 'code', yml: 'code',
  json: 'data', xml: 'data', csv: 'sheet', tsv: 'sheet', xlsx: 'sheet', xls: 'sheet',
  pdf: 'pdf', zip: 'archive', gz: 'archive', tgz: 'archive', tar: 'archive', '7z': 'archive',
  mp4: 'video', mov: 'video', webm: 'video', mp3: 'audio', m4a: 'audio', wav: 'audio', ogg: 'audio',
  png: 'image', jpg: 'image', jpeg: 'image', gif: 'image', webp: 'image', heic: 'image',
  avif: 'image', svg: 'image', bmp: 'image',
};

const TEXT_CATEGORIES = new Set<Category>(['text', 'code', 'data']);

const CATEGORY_ICON: Record<Category, LucideIcon> = {
  image: FileImage,
  text: FileText,
  code: FileCode,
  data: FileJson,
  sheet: FileSpreadsheet,
  pdf: FileText,
  archive: FileArchive,
  video: FileVideo,
  audio: FileAudio,
  binary: FileIcon,
};

const CATEGORY_LABEL: Record<Category, string> = {
  image: 'Image',
  text: 'Text',
  code: 'Code',
  data: 'Data',
  sheet: 'Spreadsheet',
  pdf: 'PDF document',
  archive: 'Archive',
  video: 'Video',
  audio: 'Audio',
  binary: 'File',
};

/** Accent per category, drawn from existing status tokens so both themes work. */
const CATEGORY_TONE: Record<Category, string> = {
  image: 'var(--sam-status-success-fg)',
  text: 'var(--sam-status-neutral-fg)',
  code: 'var(--sam-status-indigo-fg)',
  data: 'var(--sam-status-purple-fg)',
  sheet: 'var(--sam-status-success-fg)',
  pdf: 'var(--sam-status-danger-fg)',
  archive: 'var(--sam-status-warning-fg)',
  video: 'var(--sam-status-info-fg)',
  audio: 'var(--sam-status-info-fg)',
  binary: 'var(--sam-status-muted-fg)',
};

export interface AttachmentInfo {
  kind: AttachmentKind;
  category: Category;
  Icon: LucideIcon;
  /** Short uppercase badge: "PNG", "ZIP", "TXT". */
  badge: string;
  /** What the user reads: "Pasted text" for composer-generated pastes, else the file name. */
  displayName: string;
  typeLabel: string;
  tone: string;
  isPaste: boolean;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

function categorize(file: File): Category {
  const type = file.type.toLowerCase();
  const ext = extensionOf(file.name);
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type.includes('zip') || type.includes('gzip') || type.includes('tar')) {
    return EXT_CATEGORY[ext] === 'sheet' ? 'sheet' : 'archive';
  }
  if (type.includes('json') || type.includes('xml')) return 'data';
  if (type === 'text/csv') return 'sheet';
  if (type.startsWith('text/')) return EXT_CATEGORY[ext] ?? 'text';
  return EXT_CATEGORY[ext] ?? 'binary';
}

export function describeAttachment(file: File, sniffedText = false): AttachmentInfo {
  let category = categorize(file);
  if (category === 'binary' && sniffedText) category = 'text';
  const isPaste = PASTED_NAME.test(file.name);
  const ext = extensionOf(file.name);
  const renderableImage =
    category === 'image' && RENDERABLE_IMAGE.has(file.type.toLowerCase());
  const kind: AttachmentKind = renderableImage
    ? 'image'
    : TEXT_CATEGORIES.has(category) || (category === 'sheet' && ext !== 'xlsx' && ext !== 'xls')
      ? 'text'
      : 'other';
  return {
    kind,
    category,
    Icon: CATEGORY_ICON[category],
    badge: (isPaste ? 'TXT' : ext || CATEGORY_LABEL[category]).slice(0, 4).toUpperCase(),
    displayName: isPaste ? 'Pasted text' : file.name || 'Untitled',
    typeLabel: isPaste ? 'Pasted text' : ext ? `${ext.toUpperCase()} · ${CATEGORY_LABEL[category]}` : CATEGORY_LABEL[category],
    tone: CATEGORY_TONE[category],
    isPaste,
  };
}

/** A null byte or a high share of control characters in the head means binary. */
function looksLikeText(sample: string): boolean {
  if (sample.length === 0) return true;
  if (sample.includes('\u0000')) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) control++;
  }
  return control / sample.length < 0.05;
}

export interface TextStats {
  head: string;
  lines: number | null;
  chars: number | null;
}

/**
 * Reads the head of a file once: decides text-vs-binary for unknown types and returns the
 * snippet the tile/card draws. The full line count is only computed for files small enough.
 */
export function useAttachmentInfo(file: File): { info: AttachmentInfo; stats: TextStats | null } {
  const [sniffed, setSniffed] = useState<{ file: File; text: boolean; stats: TextStats } | null>(null);

  useEffect(() => {
    let cancelled = false;
    const base = describeAttachment(file);
    if (base.kind === 'image' || (base.kind === 'other' && base.category !== 'binary')) return;
    void (async () => {
      const head = await file.slice(0, DEFAULT_SNIFF_BYTES).text();
      const isText = looksLikeText(head);
      let lines: number | null = null;
      let chars: number | null = null;
      if (isText && file.size <= DEFAULT_EXACT_LINE_COUNT_BYTES) {
        const all = file.size <= DEFAULT_SNIFF_BYTES ? head : await file.text();
        chars = all.length;
        lines = all.length === 0 ? 0 : all.split('\n').length;
      }
      if (!cancelled) setSniffed({ file, text: isText, stats: { head, lines, chars } });
    })();
    return () => {
      cancelled = true;
    };
  }, [file]);

  const current = sniffed?.file === file ? sniffed : null;
  const info = describeAttachment(file, current?.text ?? false);
  return { info, stats: info.kind === 'text' ? (current?.stats ?? null) : null };
}

/** Object URL for a file, revoked when the file changes or the consumer unmounts. */
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

export function formatCount(n: number): string {
  return n.toLocaleString('en-US');
}

export function textMeta(stats: TextStats | null, size: string): string {
  if (!stats || stats.lines === null) return size;
  if (stats.lines === 0) return 'Empty';
  return `${formatCount(stats.lines)} ${stats.lines === 1 ? 'line' : 'lines'} · ${size}`;
}
