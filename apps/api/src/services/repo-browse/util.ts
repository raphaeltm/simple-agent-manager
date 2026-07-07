import type { Env } from '../../env';

/** Default cap for inlining text file content; larger files stream via rawUrl. */
export const DEFAULT_REPO_BROWSE_MAX_INLINE_BYTES = 1_000_000;

export function maxInlineBytes(env: Env): number {
  const parsed = parseInt(env.REPO_BROWSE_MAX_INLINE_BYTES || '', 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : DEFAULT_REPO_BROWSE_MAX_INLINE_BYTES;
}

export function basename(path: string): string {
  const i = path.lastIndexOf('/');
  return i === -1 ? path : path.slice(i + 1);
}

/** Heuristic binary detection: a NUL byte in the first 8KB. */
export function isBinaryBytes(bytes: Uint8Array): boolean {
  const limit = Math.min(bytes.length, 8000);
  for (let i = 0; i < limit; i++) {
    if (bytes[i] === 0) return true;
  }
  return false;
}

const CONTENT_TYPE_BY_EXT: Record<string, string> = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  svg: 'image/svg+xml',
  ico: 'image/x-icon',
  bmp: 'image/bmp',
  avif: 'image/avif',
  pdf: 'application/pdf',
};

/** Guess a content-type from a file extension; defaults to octet-stream. */
export function guessContentType(path: string): string {
  const dot = path.lastIndexOf('.');
  if (dot === -1) return 'application/octet-stream';
  return CONTENT_TYPE_BY_EXT[path.slice(dot + 1).toLowerCase()] ?? 'application/octet-stream';
}
