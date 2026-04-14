/** Image file extensions that can be rendered inline via <img> tag. */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
]);

/** MIME types that support inline preview (images + PDF + markdown). SVG excluded — script risk in iframe. */
const PREVIEWABLE_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
]);

const PREVIEWABLE_MIMES = new Set([
  ...PREVIEWABLE_IMAGE_MIMES,
  'application/pdf',
  'text/markdown',
]);

/** Check if a file path is a renderable image based on extension. */
export function isImageFile(filePath: string): boolean {
  const ext = filePath.split('.').pop()?.toLowerCase() ?? '';
  return IMAGE_EXTENSIONS.has(ext);
}

/** Check if a file path is an SVG file. */
export function isSvgFile(filePath: string): boolean {
  return filePath.toLowerCase().endsWith('.svg');
}

/** Strip MIME parameters (e.g. "; charset=utf-8") and return the base type. */
export function baseMimeType(mimeType: string): string {
  return (mimeType.split(';')[0] ?? mimeType).trim().toLowerCase();
}

/** Check if a file's MIME type supports inline preview (images + PDF + markdown). */
export function isPreviewableMime(mimeType: string): boolean {
  return PREVIEWABLE_MIMES.has(baseMimeType(mimeType));
}

/** Check if a MIME type is a previewable image (not SVG, not PDF). */
export function isPreviewableImageMime(mimeType: string): boolean {
  return PREVIEWABLE_IMAGE_MIMES.has(baseMimeType(mimeType));
}

/** Check if a MIME type is PDF. */
export function isPdfMime(mimeType: string): boolean {
  return baseMimeType(mimeType) === 'application/pdf';
}

/** Check if a MIME type is markdown. */
export function isMarkdownMime(mimeType: string): boolean {
  return baseMimeType(mimeType) === 'text/markdown';
}

/** Default threshold for inline rendering (0–10 MB). Override via VITE_FILE_PREVIEW_INLINE_MAX_BYTES. */
const DEFAULT_FILE_PREVIEW_INLINE_MAX_BYTES = 10 * 1024 * 1024;
export const FILE_PREVIEW_INLINE_MAX_BYTES =
  import.meta.env.VITE_FILE_PREVIEW_INLINE_MAX_BYTES
    ? parseInt(import.meta.env.VITE_FILE_PREVIEW_INLINE_MAX_BYTES)
    : DEFAULT_FILE_PREVIEW_INLINE_MAX_BYTES;

/** Threshold above which only download is offered (> 50 MB). Override via VITE_FILE_PREVIEW_LOAD_MAX_BYTES. */
const DEFAULT_FILE_PREVIEW_LOAD_MAX_BYTES = 50 * 1024 * 1024;
export const FILE_PREVIEW_LOAD_MAX_BYTES =
  import.meta.env.VITE_FILE_PREVIEW_LOAD_MAX_BYTES
    ? parseInt(import.meta.env.VITE_FILE_PREVIEW_LOAD_MAX_BYTES)
    : DEFAULT_FILE_PREVIEW_LOAD_MAX_BYTES;

/** Format file size as human-readable string. */
export function formatFileSize(bytes: number): string {
  if (bytes === 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}

/** Map file extensions to Prism language identifiers. */
const EXT_TO_LANG: Record<string, string> = {
  ts: 'typescript', tsx: 'tsx', js: 'javascript', jsx: 'jsx',
  go: 'go', py: 'python', css: 'css', html: 'markup', htm: 'markup',
  json: 'json', yaml: 'yaml', yml: 'yaml', md: 'markdown',
  sh: 'bash', bash: 'bash', zsh: 'bash', dockerfile: 'docker',
  toml: 'toml', sql: 'sql', rs: 'rust', rb: 'ruby', java: 'java',
  c: 'c', cpp: 'cpp', h: 'c', hpp: 'cpp', xml: 'markup', svg: 'markup',
  graphql: 'graphql', gql: 'graphql',
};

/** Detect syntax highlighting language from a file path. */
export function detectLanguage(filePath: string): string {
  const filename = filePath.split('/').pop() ?? '';
  const lower = filename.toLowerCase();
  if (lower === 'dockerfile' || lower.startsWith('dockerfile.')) return 'docker';
  if (lower === 'makefile') return 'makefile';
  const ext = lower.split('.').pop() ?? '';
  return EXT_TO_LANG[ext] ?? '';
}
