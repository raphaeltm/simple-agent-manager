import { Hono } from 'hono';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import {
  contentDispositionFilename,
  INERT_DOCUMENT_CSP,
  isActiveContentType,
} from '../../services/file-serving-policy';
import { fetchNodeAgent } from '../../services/node-agent';
import { normalizeFileProxyPath } from './_helpers';
import {
  confineForSharedReader,
  createSizeLimitedStream,
  DEFAULT_FILE_DOWNLOAD_MAX_BYTES,
  DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS,
  DEFAULT_FILE_PROXY_TIMEOUT_MS,
  DEFAULT_FILE_RAW_PROXY_MAX_BYTES,
  DEFAULT_FILE_UPLOAD_BATCH_MAX_BYTES,
  DEFAULT_FILE_UPLOAD_TIMEOUT_MS,
  FORWARDED_RESPONSE_HEADERS,
  proxyToVmAgent,
  requireConfinedResponse,
  resolveSessionWorkspace,
} from './session-workspace-proxy';

/**
 * Read routes also serve a teammate the chat is shared with, confined by the VM agent to the
 * repository working tree (idea 01M59MYE4GY91BWTE8TZF1ZB5D). Upload stays owner-only.
 */
const SHARED_READ = { allowSharedReader: true } as const;
const SHARED_GIT_READ = {
  allowSharedReader: true,
  action: 'review changes in this session',
} as const;

const fileProxyRoutes = new Hono<{ Bindings: Env }>();

/**
 * Sanitize and validate the path query parameter for read-only file proxy operations.
 * Uses normalizeFileProxyPath which allows any absolute path but blocks traversal.
 */
function requireSafePath(rawPath: string | undefined): string {
  if (!rawPath) throw errors.badRequest('path query parameter is required');
  return normalizeFileProxyPath(rawPath);
}

/** GET /:id/sessions/:sessionId/files/find — Proxy recursive file index */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/find', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const target = await resolveSessionWorkspace(c.env, projectId, sessionId, userId, SHARED_READ);
  const params = new URLSearchParams();
  confineForSharedReader(target, 'files/find', params);

  return proxyToVmAgent(c.env, target, 'files/find', params);
});

/** GET /:id/sessions/:sessionId/files/list — Proxy directory listing */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/list', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const target = await resolveSessionWorkspace(c.env, projectId, sessionId, userId, SHARED_READ);

  const params = new URLSearchParams();
  const rawPath = c.req.query('path');
  const path = rawPath ? normalizeFileProxyPath(rawPath) : undefined;
  if (path) params.set('path', path);
  confineForSharedReader(target, 'files/list', params, path);

  return proxyToVmAgent(c.env, target, 'files/list', params);
});

/** GET /:id/sessions/:sessionId/files/view — Proxy file content (via git/file on VM agent) */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/view', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const target = await resolveSessionWorkspace(c.env, projectId, sessionId, userId, SHARED_READ);

  const params = new URLSearchParams();
  const path = requireSafePath(c.req.query('path'));
  params.set('path', path);
  confineForSharedReader(target, 'git/file', params, path);

  return proxyToVmAgent(c.env, target, 'git/file', params);
});

/** GET /:id/sessions/:sessionId/git/status — Proxy git status */
fileProxyRoutes.get('/:id/sessions/:sessionId/git/status', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const target = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId,
    SHARED_GIT_READ
  );
  const params = new URLSearchParams();
  confineForSharedReader(target, 'git/status', params);

  return proxyToVmAgent(c.env, target, 'git/status', params);
});

/** GET /:id/sessions/:sessionId/git/diff — Proxy git diff for a file */
fileProxyRoutes.get('/:id/sessions/:sessionId/git/diff', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const target = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId,
    SHARED_GIT_READ
  );

  const params = new URLSearchParams();
  const rawPath = c.req.query('path');
  const path = rawPath ? normalizeFileProxyPath(rawPath) : undefined;
  if (path) params.set('path', path);
  const staged = c.req.query('staged');
  if (staged === 'true' || staged === '1') params.set('staged', staged);
  confineForSharedReader(target, 'git/diff', params, path);

  return proxyToVmAgent(c.env, target, 'git/diff', params);
});

/** GET /:id/sessions/:sessionId/files/raw — Proxy raw binary file content */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/raw', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const target = await resolveSessionWorkspace(c.env, projectId, sessionId, userId, SHARED_READ);
  const { workspaceUrl, workspaceId, nodeId, token } = target;

  const params = new URLSearchParams();
  const path = requireSafePath(c.req.query('path'));
  params.set('path', path);
  confineForSharedReader(target, 'files/raw', params, path);

  const timeoutMs = parseInt(c.env.FILE_PROXY_TIMEOUT_MS ?? String(DEFAULT_FILE_PROXY_TIMEOUT_MS));
  const maxBytes = parseInt(
    c.env.FILE_RAW_PROXY_MAX_BYTES ?? String(DEFAULT_FILE_RAW_PROXY_MAX_BYTES)
  );

  params.set('token', token);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/raw?${params.toString()}`;

  // Forward If-None-Match for ETag/304 support
  const fetchHeaders: Record<string, string> = {};
  const ifNoneMatch = c.req.header('If-None-Match');
  if (ifNoneMatch) fetchHeaders['If-None-Match'] = ifNoneMatch;

  const res = await fetchNodeAgent(nodeId, c.env, url, { headers: fetchHeaders }, timeoutMs);

  if (!res.ok && res.status !== 304) {
    const text = await res.text();
    log.error('file_proxy.vm_agent_error', {
      workspaceId,
      vmPath: 'files/raw',
      status: res.status,
      body: text,
    });
    const clientStatus =
      res.status === 404 ? 404 : res.status === 413 ? 413 : res.status >= 500 ? 502 : 400;
    throw errors.badRequest(
      clientStatus === 404
        ? 'File or resource not found'
        : clientStatus === 413
          ? 'File too large for preview'
          : clientStatus === 502
            ? 'Workspace agent unavailable'
            : 'VM agent request failed'
    );
  }

  await requireConfinedResponse(target, res, 'files/raw');

  // For 304, just forward the status
  if (res.status === 304) {
    return new Response(null, { status: 304 });
  }

  // Guard against oversized responses
  const contentLength = parseInt(res.headers.get('Content-Length') ?? '0');
  if (contentLength > maxBytes) {
    throw errors.badRequest(`File too large for preview (${contentLength} bytes)`);
  }

  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/octet-stream');
  }

  // Security headers are the proxy's own, whatever the VM agent sends. The file
  // may be agent-written HTML or SVG. The app only ever embeds these bytes as an
  // <img>, which ignores Content-Disposition; opened directly on the API origin,
  // active content downloads instead of rendering, and anything that does render
  // stays inert.
  headers.set('X-Content-Type-Options', 'nosniff');
  headers.set('Content-Security-Policy', INERT_DOCUMENT_CSP);
  if (isActiveContentType(headers.get('Content-Type') ?? '')) {
    const filename = contentDispositionFilename(path.split('/').pop() || 'file');
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
  }

  return new Response(res.body, {
    status: res.status,
    headers,
  });
});

/** POST /:id/sessions/:sessionId/files/upload — Proxy file upload to workspace */
fileProxyRoutes.post('/:id/sessions/:sessionId/files/upload', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  // Writing into the workspace stays with its owner: no teammate path here.
  const { workspaceUrl, workspaceId, nodeId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  const timeoutMs = parseInt(
    c.env.FILE_UPLOAD_TIMEOUT_MS ?? String(DEFAULT_FILE_UPLOAD_TIMEOUT_MS)
  );
  const maxBatchBytes = parseInt(
    c.env.FILE_UPLOAD_BATCH_MAX_BYTES ?? String(DEFAULT_FILE_UPLOAD_BATCH_MAX_BYTES)
  );

  // Pre-check Content-Length if present
  const contentLength = parseInt(c.req.header('Content-Length') ?? '0');
  if (contentLength > maxBatchBytes + 1024 * 1024) {
    throw errors.badRequest(`Upload too large (${contentLength} bytes)`);
  }

  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/upload?token=${encodeURIComponent(token)}`;

  const res = await fetchNodeAgent(
    nodeId,
    c.env,
    url,
    {
      method: 'POST',
      headers: {
        'Content-Type': c.req.header('Content-Type') ?? 'multipart/form-data',
      },
      body: c.req.raw.body
        ? createSizeLimitedStream(c.req.raw.body, maxBatchBytes + 1024 * 1024)
        : undefined,
      // @ts-expect-error duplex is required for streaming request bodies in fetch
      duplex: 'half',
    },
    timeoutMs
  );

  if (!res.ok) {
    const text = await res.text();
    log.error('file_proxy.upload_error', {
      workspaceId,
      status: res.status,
      body: text,
    });
    const clientStatus = res.status === 413 ? 413 : res.status >= 500 ? 502 : 400;
    if (clientStatus === 502) throw errors.internal('Workspace agent unavailable');
    throw errors.badRequest(clientStatus === 413 ? 'File too large' : 'Upload failed');
  }

  const headers = new Headers();
  headers.set('Content-Type', 'application/json');
  return new Response(res.body, { status: res.status, headers });
});

/** GET /:id/sessions/:sessionId/files/download — Proxy file download from workspace */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/download', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const target = await resolveSessionWorkspace(c.env, projectId, sessionId, userId, SHARED_READ);
  const { workspaceUrl, workspaceId, nodeId, token } = target;

  const filePath = c.req.query('path');
  if (!filePath) throw errors.badRequest('path query parameter is required');
  const safePath = normalizeFileProxyPath(filePath);

  const timeoutMs = parseInt(
    c.env.FILE_DOWNLOAD_TIMEOUT_MS ?? String(DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS)
  );
  const maxBytes = parseInt(
    c.env.FILE_DOWNLOAD_MAX_BYTES ?? String(DEFAULT_FILE_DOWNLOAD_MAX_BYTES)
  );

  const params = new URLSearchParams({ path: safePath, token });
  confineForSharedReader(target, 'files/download', params, safePath);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/download?${params.toString()}`;

  const res = await fetchNodeAgent(nodeId, c.env, url, {}, timeoutMs);

  if (!res.ok) {
    const text = await res.text();
    log.error('file_proxy.download_error', {
      workspaceId,
      path: safePath,
      status: res.status,
      body: text,
    });
    if (res.status === 404) throw errors.notFound('File not found');
    if (res.status === 413) throw errors.badRequest('File too large for download');
    if (res.status >= 500) throw errors.internal('Workspace agent unavailable');
    throw errors.badRequest('Download failed');
  }
  await requireConfinedResponse(target, res, 'files/download');

  // Guard against oversized responses
  const cl = parseInt(res.headers.get('Content-Length') ?? '0');
  if (cl > maxBytes) {
    throw errors.badRequest(`File too large for download (${cl} bytes)`);
  }

  const headers = new Headers();
  for (const name of [...FORWARDED_RESPONSE_HEADERS]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/octet-stream');
  }

  return new Response(res.body ? createSizeLimitedStream(res.body, maxBytes) : null, {
    status: res.status,
    headers,
  });
});

export { fileProxyRoutes };
