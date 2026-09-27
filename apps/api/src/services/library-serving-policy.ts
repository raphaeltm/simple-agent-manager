/**
 * How the project file library hands stored files to a browser.
 *
 * Library files are written by users and agents, so every response that carries
 * their bytes must keep the browser from treating them as active content on the
 * API origin.
 */

/** Replace characters that could break out of a quoted Content-Disposition filename. */
export function contentDispositionFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7E]|["\\;]/g, '_');
}

/** MIME types that can execute scripts when a browser renders them. */
const DANGEROUS_MIMES = [
  'text/html',
  'application/javascript',
  'application/xhtml+xml',
  'image/svg+xml',
  'text/xml',
];

/** The Content-Type `/download` serves for a stored file. */
export function downloadContentType(storedMimeType: string): string {
  return DANGEROUS_MIMES.includes(storedMimeType.toLowerCase())
    ? 'application/octet-stream'
    : storedMimeType;
}

/** MIME types safe to render inline in a browser (images, PDF, markdown, inert HTML text).
 *  Keep in sync with PREVIEWABLE_IMAGE_MIMES + PREVIEWABLE_MIMES in apps/web/src/lib/file-utils.ts */
const PREVIEWABLE_MIMES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
  'image/avif',
  'application/pdf',
  'text/markdown',
  'text/html',
]);

export function isInlinePreviewable(effectiveMimeType: string): boolean {
  return PREVIEWABLE_MIMES.has(effectiveMimeType);
}

export interface PreviewHeaders {
  readonly contentType: string;
  readonly contentSecurityPolicy: string;
}

/** Content-Type and CSP for an inline preview of a file with the given effective type. */
export function previewHeaders(effectiveMimeType: string): PreviewHeaders {
  const contentType =
    effectiveMimeType === 'text/html' ? 'text/plain; charset=utf-8' : effectiveMimeType;
  // PDF viewers need script-src for browser-native rendering; images get strict CSP
  const contentSecurityPolicy =
    effectiveMimeType === 'application/pdf'
      ? "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; object-src 'self'"
      : effectiveMimeType === 'text/html'
        ? "default-src 'none'"
        : "default-src 'none'; style-src 'unsafe-inline'";
  return { contentType, contentSecurityPolicy };
}
