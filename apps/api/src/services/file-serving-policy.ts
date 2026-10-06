/**
 * How the API hands a browser the bytes of a file that a user or an agent wrote:
 * library files, repository files and workspace files.
 *
 * A browser must never run those bytes as script, or render them as an active
 * document, on the API origin.
 */
import { normalizeMimeType, OCTET_STREAM_MIME } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { appFrameAncestors } from '../lib/app-origin';

/** Replace characters that could break out of a quoted Content-Disposition filename. */
export function contentDispositionFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7E]|["\\;]/g, '_');
}

/**
 * Types a browser runs as script or renders as an active document. Every `+xml`
 * type (SVG, XHTML, RSS, ...) is one too.
 */
const ACTIVE_CONTENT_TYPES = new Set([
  'text/html',
  'text/xml',
  'application/xml',
  'text/xsl',
  'text/javascript',
  'application/javascript',
  'application/ecmascript',
  'text/ecmascript',
  'application/x-javascript',
]);

/**
 * Exactly one media type with optional parameters (RFC 9110 §8.3.1). A quoted
 * value is printable ASCII without `"`, `\` or `,`: no commas at all, because a
 * browser picks one entry of a comma-separated list.
 */
const SINGLE_MEDIA_TYPE =
  /^[\w!#$%&'*+.^`|~-]+\/[\w!#$%&'*+.^`|~-]+(?:[ \t]*;[ \t]*[\w!#$%&'*+.^`|~-]+=(?:[\w!#$%&'*+.^`|~-]+|"[\x20\x21\x23-\x2b\x2d-\x5b\x5d-\x7e]*"))*$/;

/**
 * Whether a browser could run a response of this type as script or render it as
 * an active document. Parameters such as `; charset=utf-8` do not change the
 * verdict. A value that is not exactly one well-formed media type counts too:
 * what a browser makes of it is unknown, and it may not be echoed into a header.
 */
export function isActiveContentType(mimeType: string): boolean {
  if (!SINGLE_MEDIA_TYPE.test(mimeType)) return true;
  const baseType = normalizeMimeType(mimeType);
  return ACTIVE_CONTENT_TYPES.has(baseType) || baseType.endsWith('+xml');
}

/** The Content-Type to download a stored file as: its own, unless a browser could run it. */
export function downloadContentType(storedMimeType: string): string {
  return isActiveContentType(storedMimeType) ? OCTET_STREAM_MIME : storedMimeType;
}

/**
 * CSP for raw file bytes. Whatever the bytes turn out to be, a browser that opens
 * them runs no script, fetches nothing, and gives the document an opaque origin.
 * Images embedded with `<img>` are unaffected.
 */
export const INERT_DOCUMENT_CSP = "default-src 'none'; style-src 'unsafe-inline'; sandbox";

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

const PDF_SIGNATURE = new TextEncoder().encode('%PDF-');

function startsWithPdfSignature(bytes: ArrayBuffer): boolean {
  if (bytes.byteLength < PDF_SIGNATURE.length) return false;
  const header = new Uint8Array(bytes, 0, PDF_SIGNATURE.length);
  return PDF_SIGNATURE.every((byte, index) => header[index] === byte);
}

/**
 * Whether decrypted bytes may be previewed as their effective type. A PDF is
 * served with a looser CSP than anything else, so it must actually be one: a
 * stored `application/pdf` or a `.pdf` name alone does not qualify.
 */
export function hasPreviewableContent(effectiveMimeType: string, bytes: ArrayBuffer): boolean {
  return effectiveMimeType !== 'application/pdf' || startsWithPdfSignature(bytes);
}

/** No preview runs script: they only ever render images, PDFs and text. */
function previewSources(effectiveMimeType: string): string {
  switch (effectiveMimeType) {
    // Browser PDF viewers embed the document as an object and style their own
    // page; none needs page script.
    case 'application/pdf':
      return "default-src 'self'; script-src 'none'; style-src 'unsafe-inline'; object-src 'self'";
    // Served as plain text, which needs nothing at all.
    case 'text/html':
      return "default-src 'none'";
    default:
      return "default-src 'none'; style-src 'unsafe-inline'";
  }
}

export interface PreviewHeaders {
  readonly contentType: string;
  readonly contentSecurityPolicy: string;
}

/**
 * Content-Type and CSP for an inline library preview of a file with the given
 * effective type. Only the app may frame it.
 */
export function previewHeaders(
  effectiveMimeType: string,
  env: Pick<Env, 'BASE_DOMAIN'>
): PreviewHeaders {
  return {
    contentType:
      effectiveMimeType === 'text/html' ? 'text/plain; charset=utf-8' : effectiveMimeType,
    contentSecurityPolicy: `${previewSources(effectiveMimeType)}; ${appFrameAncestors(env)}`,
  };
}
