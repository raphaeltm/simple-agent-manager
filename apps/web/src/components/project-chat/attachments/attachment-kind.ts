/**
 * Classifies a composer attachment (a browser `File`) for display: how to preview it
 * (image / video / text / other), which icon and short badge to show, and what to call it.
 *
 * Everything here reads the local file the user picked. Nothing is fetched back from R2, so a
 * file that failed to upload, or was too large to upload, can still be identified.
 */
import { resolveEffectiveMimeType } from '@simple-agent-manager/shared';
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

import { isPreviewableImageMime, isVideoMime } from '../../../lib/file-utils';

function positiveIntEnv(raw: string | undefined, fallback: number): number {
  const parsed = Number(raw);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const DEFAULT_ATTACHMENT_SNIFF_BYTES = 4096;
export const DEFAULT_ATTACHMENT_PREVIEW_TEXT_MAX_BYTES = 256 * 1024;
export const DEFAULT_ATTACHMENT_PREVIEW_TEXT_MAX_LINES = 2000;
export const DEFAULT_ATTACHMENT_PREVIEW_LINE_MAX_CHARS = 20_000;
export const DEFAULT_ATTACHMENT_LINE_COUNT_MAX_BYTES = 8 * 1024 * 1024;

/** Bytes read from the head of a file to sniff text vs binary and draw the card snippet. */
export const ATTACHMENT_SNIFF_BYTES = positiveIntEnv(
  import.meta.env.VITE_ATTACHMENT_SNIFF_BYTES,
  DEFAULT_ATTACHMENT_SNIFF_BYTES
);
/** Bytes of a text attachment read into the viewer; larger files show a truncation note. */
export const ATTACHMENT_PREVIEW_TEXT_MAX_BYTES = positiveIntEnv(
  import.meta.env.VITE_ATTACHMENT_PREVIEW_TEXT_MAX_BYTES,
  DEFAULT_ATTACHMENT_PREVIEW_TEXT_MAX_BYTES
);
/** Lines rendered in the text viewer (DOM cost). */
export const ATTACHMENT_PREVIEW_TEXT_MAX_LINES = positiveIntEnv(
  import.meta.env.VITE_ATTACHMENT_PREVIEW_TEXT_MAX_LINES,
  DEFAULT_ATTACHMENT_PREVIEW_TEXT_MAX_LINES
);
/** Characters rendered per line; minified JSON can be a single 300 KB line. */
export const ATTACHMENT_PREVIEW_LINE_MAX_CHARS = positiveIntEnv(
  import.meta.env.VITE_ATTACHMENT_PREVIEW_LINE_MAX_CHARS,
  DEFAULT_ATTACHMENT_PREVIEW_LINE_MAX_CHARS
);
/** Text files up to this size are read in full so the card can show an exact line count. */
export const ATTACHMENT_LINE_COUNT_MAX_BYTES = positiveIntEnv(
  import.meta.env.VITE_ATTACHMENT_LINE_COUNT_MAX_BYTES,
  DEFAULT_ATTACHMENT_LINE_COUNT_MAX_BYTES
);

export type AttachmentKind = 'image' | 'video' | 'text' | 'other';

type Category =
  'image' | 'video' | 'audio' | 'text' | 'code' | 'data' | 'sheet' | 'pdf' | 'archive' | 'binary';

/** Name the composer gives a long paste (`ProjectChatComposer` onPaste). */
const PASTED_NAME = /^pasted-\d+\.txt$/;

/** Extensions the shared MIME table doesn't cover, used only to pick an icon. */
const EXTENSION_CATEGORY: Readonly<Record<string, Category>> = {
  txt: 'text',
  md: 'text',
  markdown: 'text',
  log: 'text',
  rst: 'text',
  ts: 'code',
  tsx: 'code',
  js: 'code',
  jsx: 'code',
  mjs: 'code',
  go: 'code',
  py: 'code',
  rs: 'code',
  rb: 'code',
  java: 'code',
  kt: 'code',
  swift: 'code',
  c: 'code',
  h: 'code',
  cpp: 'code',
  cs: 'code',
  php: 'code',
  sh: 'code',
  css: 'code',
  scss: 'code',
  html: 'code',
  sql: 'code',
  toml: 'code',
  yaml: 'code',
  yml: 'code',
  ini: 'code',
  env: 'code',
  json: 'data',
  xml: 'data',
  csv: 'sheet',
  tsv: 'sheet',
  xlsx: 'sheet',
  xls: 'sheet',
  ods: 'sheet',
  pdf: 'pdf',
  zip: 'archive',
  gz: 'archive',
  tgz: 'archive',
  tar: 'archive',
  '7z': 'archive',
  rar: 'archive',
  bz2: 'archive',
  xz: 'archive',
  mp3: 'audio',
  m4a: 'audio',
  wav: 'audio',
  ogg: 'audio',
  flac: 'audio',
  aac: 'audio',
  heic: 'image',
  heif: 'image',
  tif: 'image',
  tiff: 'image',
  bmp: 'image',
  ico: 'image',
  mkv: 'video',
  avi: 'video',
};

/** Categories whose content the viewer shows as text. */
const TEXT_CATEGORIES: ReadonlySet<Category> = new Set(['text', 'code', 'data']);
/** Binary spreadsheet formats; csv/tsv are text. */
const BINARY_SHEET_EXTENSIONS: ReadonlySet<string> = new Set(['xlsx', 'xls', 'ods']);

const CATEGORY_ICON: Readonly<Record<Category, LucideIcon>> = {
  image: FileImage,
  video: FileVideo,
  audio: FileAudio,
  text: FileText,
  code: FileCode,
  data: FileJson,
  sheet: FileSpreadsheet,
  pdf: FileText,
  archive: FileArchive,
  binary: FileIcon,
};

const CATEGORY_LABEL: Readonly<Record<Category, string>> = {
  image: 'Image',
  video: 'Video',
  audio: 'Audio',
  text: 'Text',
  code: 'Code',
  data: 'Data',
  sheet: 'Spreadsheet',
  pdf: 'PDF document',
  archive: 'Archive',
  binary: 'File',
};

/** Accent per category, from status tokens so both themes work. */
const CATEGORY_TONE: Readonly<Record<Category, string>> = {
  image: 'var(--sam-status-success-fg)',
  video: 'var(--sam-status-info-fg)',
  audio: 'var(--sam-status-info-fg)',
  text: 'var(--sam-status-neutral-fg)',
  code: 'var(--sam-status-indigo-fg)',
  data: 'var(--sam-status-purple-fg)',
  sheet: 'var(--sam-status-success-fg)',
  pdf: 'var(--sam-status-danger-fg)',
  archive: 'var(--sam-status-warning-fg)',
  binary: 'var(--sam-status-muted-fg)',
};

export interface AttachmentInfo {
  kind: AttachmentKind;
  Icon: LucideIcon;
  /** Short uppercase badge such as "PNG", "ZIP" or "TXT". */
  badge: string;
  /** "Pasted text" for a composer paste, otherwise the file name. */
  displayName: string;
  /** "PNG · Image", "Pasted text", "File". */
  typeLabel: string;
  tone: string;
  isPaste: boolean;
  /** Unknown binary type whose head is worth reading: it may turn out to be text. */
  sniffable: boolean;
}

function extensionOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : '';
}

/** Own-property lookup: a file name is user input, so `constructor` must not resolve. */
function extensionCategory(ext: string): Category | undefined {
  return Object.hasOwn(EXTENSION_CATEGORY, ext) ? EXTENSION_CATEGORY[ext] : undefined;
}

function categorize(file: File, ext: string): Category {
  const type = resolveEffectiveMimeType(file.type, file.name);
  if (type.startsWith('image/')) return 'image';
  if (type.startsWith('video/')) return 'video';
  if (type.startsWith('audio/')) return 'audio';
  if (type === 'application/pdf') return 'pdf';
  if (type === 'text/csv' || type === 'text/tab-separated-values') return 'sheet';
  if (type.includes('zip') || type.includes('gzip') || type.includes('x-tar')) {
    return extensionCategory(ext) === 'sheet' ? 'sheet' : 'archive';
  }
  if (type.includes('json') || type.includes('xml')) return 'data';
  if (type.includes('yaml') || type.includes('toml') || type.includes('javascript')) return 'code';
  if (type.startsWith('text/')) return extensionCategory(ext) ?? 'text';
  return extensionCategory(ext) ?? 'binary';
}

/**
 * `sniffedText` upgrades an unknown binary (a `Dockerfile`, `Makefile`, `.env.example`) to text
 * once `looksLikeText` has read its head.
 */
export function describeAttachment(file: File, sniffedText = false): AttachmentInfo {
  const ext = extensionOf(file.name);
  let category = categorize(file, ext);
  if (category === 'binary' && sniffedText) category = 'text';
  const isPaste = PASTED_NAME.test(file.name);
  const kind: AttachmentKind =
    // SVG renders through <img>, where its scripts never run (the library excludes it only
    // because it previews in an iframe).
    category === 'image' &&
    (isPreviewableImageMime(file.type, file.name) ||
      resolveEffectiveMimeType(file.type, file.name) === 'image/svg+xml')
      ? 'image'
      : category === 'video' && isVideoMime(file.type, file.name)
        ? 'video'
        : TEXT_CATEGORIES.has(category) ||
            (category === 'sheet' && !BINARY_SHEET_EXTENSIONS.has(ext))
          ? 'text'
          : 'other';
  const label = CATEGORY_LABEL[category];
  return {
    kind,
    Icon: CATEGORY_ICON[category],
    badge: (isPaste ? 'TXT' : ext || label).slice(0, 4).toUpperCase(),
    displayName: isPaste ? 'Pasted text' : file.name || 'Untitled',
    typeLabel: isPaste ? 'Pasted text' : ext ? `${ext.toUpperCase()} · ${label}` : label,
    tone: CATEGORY_TONE[category],
    isPaste,
    sniffable: category === 'binary',
  };
}

/** True when the head of a file decodes as text: no NUL byte and under 5% control characters. */
export function looksLikeText(sample: string): boolean {
  if (sample.length === 0) return true;
  if (sample.includes('\u0000')) return false;
  let control = 0;
  for (let i = 0; i < sample.length; i++) {
    const c = sample.charCodeAt(i);
    if ((c < 32 && c !== 9 && c !== 10 && c !== 13) || c === 0xfffd) control++;
  }
  return control / sample.length < 0.05;
}

export function countLines(text: string): number {
  if (text.length === 0) return 0;
  let lines = 1;
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) lines++;
  // A trailing newline ends the last line rather than starting a new one.
  return text.endsWith('\n') ? lines - 1 : lines;
}

export function pluralLines(n: number): string {
  return `${n.toLocaleString('en-US')} ${n === 1 ? 'line' : 'lines'}`;
}
