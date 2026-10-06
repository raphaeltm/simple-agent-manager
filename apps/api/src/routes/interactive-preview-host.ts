import { LIBRARY_DEFAULTS, resolveEffectiveMimeType } from '@simple-agent-manager/shared';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../db/schema';
import type { Env } from '../env';
import { downloadFile, getDownloadTimeoutMs, getFile } from '../services/file-library';
import {
  getInteractivePreviewHeaders,
  getPreviewHostname,
  interactivePreviewErrorResponse,
  verifyPreviewPath,
} from '../services/interactive-preview';
function previewMaxBytes(env: Env): number {
  const parsed = Number(env.FILE_PREVIEW_MAX_BYTES);
  return Number.isSafeInteger(parsed) && parsed > 0
    ? parsed
    : LIBRARY_DEFAULTS.FILE_PREVIEW_MAX_BYTES;
}
function encryptionKey(env: Env): string {
  const key = env.LIBRARY_ENCRYPTION_KEY ?? env.ENCRYPTION_KEY;
  if (!key) throw new Error('Library encryption key is not configured');
  return key;
}
export function isInteractivePreviewRequest(request: Request, env: Env): boolean {
  try {
    return new URL(request.url).hostname.toLowerCase() === getPreviewHostname(env);
  } catch {
    return false;
  }
}
export async function handleInteractivePreviewRequest(
  request: Request,
  env: Env
): Promise<Response> {
  try {
    if (request.method !== 'GET' && request.method !== 'HEAD')
      return interactivePreviewErrorResponse(env);
    if (!env.PREVIEW_SIGNING_KEY) return interactivePreviewErrorResponse(env);
    const scope = await verifyPreviewPath(new URL(request.url).pathname, env.PREVIEW_SIGNING_KEY);
    if (!scope) return interactivePreviewErrorResponse(env);
    const db = drizzle(env.DATABASE, { schema });
    const { file } = await getFile(db, scope.projectId, scope.fileId);
    if (
      file.updatedAt !== scope.version ||
      resolveEffectiveMimeType(file.mimeType, file.filename) !== 'text/html' ||
      file.sizeBytes > previewMaxBytes(env)
    ) {
      return interactivePreviewErrorResponse(env);
    }
    const timeoutMs = getDownloadTimeoutMs(env);
    let timeout: ReturnType<typeof setTimeout> | undefined;
    const { data } = await Promise.race([
      downloadFile(db, env.R2, encryptionKey(env), scope.projectId, scope.fileId),
      new Promise<never>((_, reject) => {
        timeout = setTimeout(() => reject(new Error('Preview timed out')), timeoutMs);
      }),
    ]).finally(() => clearTimeout(timeout));
    const headers = getInteractivePreviewHeaders(env);
    headers.set('Content-Type', 'text/html; charset=utf-8');
    headers.set('Content-Length', String(data.byteLength));
    return new Response(request.method === 'HEAD' ? null : data, { status: 200, headers });
  } catch {
    return interactivePreviewErrorResponse(env);
  }
}
