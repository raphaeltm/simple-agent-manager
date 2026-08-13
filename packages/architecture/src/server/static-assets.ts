import { createReadStream } from 'node:fs';
import { existsSync } from 'node:fs';
import { stat } from 'node:fs/promises';
import type { ServerResponse } from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { HttpError } from './http';

const VIEWER_DIR = resolveViewerDir();
const VIEWER_INDEX = 'viewer.html';
const CONTENT_TYPES = new Map([
  ['.html', 'text/html; charset=utf-8'],
  ['.js', 'text/javascript; charset=utf-8'],
  ['.css', 'text/css; charset=utf-8'],
  ['.svg', 'image/svg+xml'],
]);

export async function serveViewerAsset(
  pathname: string,
  response: ServerResponse
): Promise<boolean> {
  const relative = pathname === '/' ? VIEWER_INDEX : pathname.replace(/^\/+/, '');
  const candidate = path.resolve(VIEWER_DIR, relative);
  if (!candidate.startsWith(`${VIEWER_DIR}${path.sep}`) && candidate !== VIEWER_DIR) {
    throw new HttpError(400, 'Viewer asset path escapes the asset root.', 'asset-path-invalid');
  }
  const filePath = pathname.startsWith('/assets/') ? candidate : path.join(VIEWER_DIR, VIEWER_INDEX);
  try {
    const stats = await stat(filePath);
    if (!stats.isFile()) return false;
    response.writeHead(200, {
      'cache-control': 'no-store',
      'content-type': CONTENT_TYPES.get(path.extname(filePath)) ?? 'application/octet-stream',
    });
    createReadStream(filePath).pipe(response);
    return true;
  } catch (error) {
    if (error instanceof Error && 'code' in error && error.code === 'ENOENT') {
      throw new HttpError(503, 'Viewer assets are not built. Run the architecture package build first.', 'viewer-unbuilt');
    }
    throw error;
  }
}

function resolveViewerDir(): string {
  const builtViewer = path.resolve(process.cwd(), 'dist/viewer');
  if (existsSync(builtViewer)) return builtViewer;
  if (import.meta.url.startsWith('file:')) {
    return path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../viewer');
  }
  return builtViewer;
}
