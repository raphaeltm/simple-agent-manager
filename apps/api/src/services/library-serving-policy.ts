/**
 * How the project file library hands stored files to a browser.
 *
 * Library files are written by users and agents, so every response that carries
 * their bytes must keep the browser from treating them as active content on the
 * API origin.
 */
import { normalizeMimeType, OCTET_STREAM_MIME } from '@simple-agent-manager/shared';

import type { Env } from '../env';
import { isLocalDevelopmentBaseDomain, LOCAL_DEVELOPMENT_HOSTS } from '../lib/cors-origin';
import { getAppOrigin } from './interactive-preview';

/** Replace characters that could break out of a quoted Content-Disposition filename. */
export function contentDispositionFilename(filename: string): string {
  return filename.replace(/[^\x20-\x7E]|["\\;]/g, '_');
}

/**
 * Types a browser runs as script or renders as an active document. Every `+xml`
 * type (SVG, XHTML, RSS, ...) is one too.
 */
const EXECUTABLE_MIME_TYPES = new Set([
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
 * The Content-Type `/download` serves for a stored file: the stored type, unless
 * a browser could execute it. Parameters such as `; charset=utf-8` do not change
 * the verdict, and a comma-separated list is never echoed, because browsers pick
 * one of its entries.
 */
export function downloadContentType(storedMimeType: string): string {
  const baseType = normalizeMimeType(storedMimeType);
  const executable = EXECUTABLE_MIME_TYPES.has(baseType) || baseType.endsWith('+xml');
  return executable || storedMimeType.includes(',') ? OCTET_STREAM_MIME : storedMimeType;
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

/**
 * Only the app may frame a preview. The app lives on `app.<domain>` and previews
 * come from `api.<domain>`, a different origin, so `'self'` would block the app's
 * own PDF preview, and so would X-Frame-Options, which cannot name another
 * origin. Local development serves the app from a loopback port.
 */
function frameAncestors(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const ancestors = [getAppOrigin(env)];
  if (isLocalDevelopmentBaseDomain(env.BASE_DOMAIN)) {
    ancestors.push(...LOCAL_DEVELOPMENT_HOSTS.map((host) => `http://${host}:*`));
  }
  return `frame-ancestors ${ancestors.join(' ')}`;
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

/** Content-Type and CSP for an inline preview of a file with the given effective type. */
export function previewHeaders(
  effectiveMimeType: string,
  env: Pick<Env, 'BASE_DOMAIN'>
): PreviewHeaders {
  return {
    contentType:
      effectiveMimeType === 'text/html' ? 'text/plain; charset=utf-8' : effectiveMimeType,
    contentSecurityPolicy: `${previewSources(effectiveMimeType)}; ${frameAncestors(env)}`,
  };
}
