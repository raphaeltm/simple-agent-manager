/** Image file extensions that can be rendered inline via <img> tag. */
const IMAGE_EXTENSIONS = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'avif', 'ico', 'bmp',
]);

/** MIME types that support inline preview (images + PDF). SVG excluded — script risk in iframe. */
const PREVIEWABLE_IMAGE_MIMES = new Set([
  'image/png', 'image/jpeg', 'image/gif', 'image/webp', 'image/avif',
]);

const PREVIEWABLE_MIMES = new Set([
  ...PREVIEWABLE_IMAGE_MIMES,
  'application/pdf',
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

/** Check if a file's MIME type supports inline preview (images + PDF). */
export function isPreviewableMime(mimeType: string): boolean {
  return PREVIEWABLE_MIMES.has(mimeType.toLowerCase());
}

/** Check if a MIME type is a previewable image (not SVG, not PDF). */
export function isPreviewableImageMime(mimeType: string): boolean {
  return PREVIEWABLE_IMAGE_MIMES.has(mimeType.toLowerCase());
}

/** Check if a MIME type is PDF. */
export function isPdfMime(mimeType: string): boolean {
  return mimeType.toLowerCase() === 'application/pdf';
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
  const units = ['B', 'KB', 'MB', 'GB'];
  const i = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const val = bytes / Math.pow(1024, i);
  return `${val < 10 ? val.toFixed(1) : Math.round(val)} ${units[i]}`;
}
