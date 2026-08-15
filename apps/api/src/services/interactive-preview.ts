import type { Env } from '../env';
export const DEFAULT_PREVIEW_URL_TTL_SECONDS = 300;
const encoder = new TextEncoder();
const decoder = new TextDecoder();
export interface PreviewPathScope {
  projectId: string;
  fileId: string;
  version: string;
  expiresAt: number;
}
export function getPreviewUrlTtlSeconds(env: Pick<Env, 'PREVIEW_URL_TTL_SECONDS'>): number {
  const value = Number(env.PREVIEW_URL_TTL_SECONDS);
  return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_PREVIEW_URL_TTL_SECONDS;
}
export function getPreviewHostname(env: Pick<Env, 'BASE_DOMAIN' | 'PREVIEW_BASE_DOMAIN'>): string {
  const override = env.PREVIEW_BASE_DOMAIN?.trim().toLowerCase();
  if (override) return override;
  const baseDomain = env.BASE_DOMAIN?.trim().toLowerCase();
  if (!baseDomain) throw new Error('BASE_DOMAIN is required for interactive previews');
  return `preview.${baseDomain}`;
}
export function getAppOrigin(env: Pick<Env, 'BASE_DOMAIN'>): string {
  const baseDomain = env.BASE_DOMAIN?.trim().toLowerCase();
  if (!baseDomain) throw new Error('BASE_DOMAIN is required to build the app origin');
  return `https://app.${baseDomain}`;
}

export const getPreviewAppOrigin = getAppOrigin;
function base64UrlEncode(bytes: Uint8Array): string {
  let binary = '';
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll('+', '-').replaceAll('/', '_').replace(/=+$/, '');
}
function base64UrlDecode(value: string): Uint8Array | null {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) return null;
  try {
    const padded =
      value.replaceAll('-', '+').replaceAll('_', '/') + '='.repeat((4 - (value.length % 4)) % 4);
    const binary = atob(padded);
    return Uint8Array.from(binary, (character) => character.charCodeAt(0));
  } catch {
    return null;
  }
}
function encodePart(value: string): string {
  return base64UrlEncode(encoder.encode(value));
}
function decodePart(value: string): string | null {
  const bytes = base64UrlDecode(value);
  return bytes ? decoder.decode(bytes) : null;
}
async function sign(prefix: string, secret: string): Promise<Uint8Array> {
  if (!secret) throw new Error('PREVIEW_SIGNING_KEY is not configured');
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, encoder.encode(prefix)));
}
export function buildPreviewUnsignedPrefix(scope: PreviewPathScope): string {
  return `/p/${encodePart(scope.projectId)}/${encodePart(scope.fileId)}/${encodePart(scope.version)}/${scope.expiresAt}`;
}
export async function mintPreviewPath(scope: PreviewPathScope, secret: string): Promise<string> {
  const prefix = buildPreviewUnsignedPrefix(scope);
  return `${prefix}/${base64UrlEncode(await sign(prefix, secret))}/index.html`;
}
function constantTimeEqual(left: Uint8Array, right: Uint8Array): boolean {
  const length = Math.max(left.length, right.length);
  let mismatch = left.length ^ right.length;
  for (let index = 0; index < length; index += 1)
    mismatch |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return mismatch === 0;
}
export async function verifyPreviewPath(
  pathname: string,
  secret: string,
  nowSeconds = Math.floor(Date.now() / 1000)
): Promise<PreviewPathScope | null> {
  const match = pathname.match(/^\/p\/([^/]+)\/([^/]+)\/([^/]+)\/(\d+)\/([^/]+)\/index\.html$/);
  if (!match) return null;
  const [, encodedProjectId, encodedFileId, encodedVersion, expiryRaw, signatureRaw] = match;
  if (
    encodedProjectId === undefined ||
    encodedFileId === undefined ||
    encodedVersion === undefined ||
    expiryRaw === undefined ||
    signatureRaw === undefined
  ) {
    return null;
  }
  const projectId = decodePart(encodedProjectId);
  const fileId = decodePart(encodedFileId);
  const version = decodePart(encodedVersion);
  const expiresAt = Number(expiryRaw);
  if (
    !projectId ||
    !fileId ||
    !version ||
    !Number.isSafeInteger(expiresAt) ||
    expiresAt <= nowSeconds
  )
    return null;
  const prefix = `/p/${encodedProjectId}/${encodedFileId}/${encodedVersion}/${expiresAt}`;
  const received = base64UrlDecode(signatureRaw);
  if (!received || !constantTimeEqual(await sign(prefix, secret), received)) return null;
  return { projectId, fileId, version, expiresAt };
}
export function getInteractivePreviewCsp(env: Pick<Env, 'BASE_DOMAIN'>): string {
  return [
    'sandbox allow-scripts',
    "default-src 'none'",
    "script-src 'unsafe-inline'",
    "style-src 'unsafe-inline'",
    'img-src data: blob:',
    "connect-src 'none'",
    "worker-src 'none'",
    "object-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
    `frame-ancestors ${getPreviewAppOrigin(env)}`,
  ].join('; ');
}
export function getInteractivePreviewHeaders(env: Pick<Env, 'BASE_DOMAIN'>): Headers {
  return new Headers({
    'Content-Security-Policy': getInteractivePreviewCsp(env),
    'X-Content-Type-Options': 'nosniff',
    'Referrer-Policy': 'no-referrer',
    'Cache-Control': 'private, no-store',
  });
}
export function interactivePreviewErrorResponse(env: Pick<Env, 'BASE_DOMAIN'>): Response {
  const headers = getInteractivePreviewHeaders(env);
  headers.set('Content-Type', 'text/html; charset=utf-8');
  return new Response(
    '<!doctype html><html><head><meta charset="utf-8"><title>Preview expired</title></head><body><main><h1>Preview link expired</h1><p>Reopen it from SAM to create a fresh link.</p></main></body></html>',
    { status: 403, headers }
  );
}
