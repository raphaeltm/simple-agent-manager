import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import { Hono } from 'hono';

import * as schema from '../../db/schema';
import type { Env } from '../../index';
import { log } from '../../lib/logger';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { signTerminalToken } from '../../services/jwt';
import * as projectDataService from '../../services/project-data';
import { normalizeFileProxyPath } from './_helpers';

const fileProxyRoutes = new Hono<{ Bindings: Env }>();

/** Default timeout for VM agent proxy requests (configurable via FILE_PROXY_TIMEOUT_MS). */
const DEFAULT_FILE_PROXY_TIMEOUT_MS = 15_000;
/** Default max response size from VM agent (configurable via FILE_PROXY_MAX_RESPONSE_BYTES). */
const DEFAULT_FILE_PROXY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
/** Default max response size for raw binary file proxy (configurable via FILE_RAW_PROXY_MAX_BYTES). */
const DEFAULT_FILE_RAW_PROXY_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
/** Default max batch upload size (configurable via FILE_UPLOAD_BATCH_MAX_BYTES). */
const DEFAULT_FILE_UPLOAD_BATCH_MAX_BYTES = 250 * 1024 * 1024; // 250 MB
/** Default timeout for upload proxy requests (configurable via FILE_UPLOAD_TIMEOUT_MS). */
const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;
/** Default timeout for download proxy requests (configurable via FILE_DOWNLOAD_TIMEOUT_MS). */
const DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Default max file download size (configurable via FILE_DOWNLOAD_MAX_BYTES). */
const DEFAULT_FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/** Response headers safe to forward from VM agent to the client. */
const FORWARDED_RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Disposition',
  'Cache-Control',
  'ETag',
  'Last-Modified',
];

/** Additional headers forwarded for raw binary file responses (security headers set by VM agent). */
const RAW_FILE_EXTRA_HEADERS = [
  'Content-Security-Policy',
  'X-Content-Type-Options',
];

/**
 * Resolve workspace from a chat session and build the VM agent URL + token.
 * Looks up the workspace by chatSessionId in D1 (workspaces table).
 * Returns { workspaceUrl, workspaceId, token } or throws if unavailable.
 */
async function resolveSessionWorkspace(
  env: Env,
  projectId: string,
  sessionId: string,
  userId: string
) {
  const db = drizzle(env.DATABASE, { schema });

  // Verify project ownership
  await requireOwnedProject(db, projectId, userId);

  // Strategy 1: Find workspace by chatSessionId in D1 (canonical path)
  const workspaces = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
      projectId: schema.workspaces.projectId,
      nodeId: schema.workspaces.nodeId,
    })
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.chatSessionId, sessionId),
        eq(schema.workspaces.projectId, projectId),
        eq(schema.workspaces.userId, userId)
      )
    )
    .limit(1);

  let workspace = workspaces[0];
  let lookupStrategy = workspace ? 'chatSessionId' : 'none';

  // Strategy 2: Fall back to the session's workspaceId from the ProjectData DO.
  // This handles the case where chatSessionId was not written to D1 (e.g., DO
  // crash during workspace creation left the link incomplete).
  if (!workspace) {
    const session = await projectDataService.getSession(env, projectId, sessionId);
    const raw = session?.workspaceId;
    const sessionWorkspaceId = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    if (sessionWorkspaceId) {
      const fallbackWorkspaces = await db
        .select({
          id: schema.workspaces.id,
          status: schema.workspaces.status,
          projectId: schema.workspaces.projectId,
          nodeId: schema.workspaces.nodeId,
        })
        .from(schema.workspaces)
        .where(
          and(
            eq(schema.workspaces.id, sessionWorkspaceId),
            eq(schema.workspaces.projectId, projectId),
            eq(schema.workspaces.userId, userId)
          )
        )
        .limit(1);
      workspace = fallbackWorkspaces[0];
      if (workspace) lookupStrategy = 'sessionWorkspaceId-fallback';
    }
  }

  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  // Defensive assertion: workspace must belong to the expected project
  if (workspace.projectId !== projectId) {
    throw errors.forbidden('Workspace does not belong to this project');
  }

  log.info('file_proxy.workspace_resolved', {
    sessionId,
    workspaceId: workspace.id,
    workspaceStatus: workspace.status,
    nodeId: workspace.nodeId,
    lookupStrategy,
  });

  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    throw errors.badRequest(
      `Workspace is not accessible (status: ${workspace.status})`
    );
  }

  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no assigned node');
  }

  // Use the two-level subdomain ({nodeId}.vm.{domain}) to bypass Cloudflare
  // same-zone routing restrictions. Single-level ws-{id}.{domain} subdomains
  // are intercepted by the Worker route, causing error 1014 on server-side fetch.
  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  const workspaceUrl = `${protocol}://${workspace.nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}`;
  const { token } = await signTerminalToken(userId, workspace.id, env);

  return { workspaceUrl, workspaceId: workspace.id, token };
}

/**
 * Proxy a request to the VM agent, forwarding query params and returning the response.
 * Token is passed via query param (VM agent's requireWorkspaceRequestAuth expects this).
 */
async function proxyToVmAgent(
  env: Env,
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  vmPath: string,
  queryParams: URLSearchParams
): Promise<Response> {
  const timeoutMs = parseInt(env.FILE_PROXY_TIMEOUT_MS ?? String(DEFAULT_FILE_PROXY_TIMEOUT_MS));
  const maxBytes = parseInt(env.FILE_PROXY_MAX_RESPONSE_BYTES ?? String(DEFAULT_FILE_PROXY_MAX_RESPONSE_BYTES));

  queryParams.set('token', token);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/${vmPath}?${queryParams.toString()}`;

  let res: Response;
  try {
    res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  } catch (fetchErr) {
    // Network error, DNS failure, or timeout — VM agent is completely unreachable
    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    log.error('file_proxy.fetch_error', {
      workspaceId,
      vmPath,
      url: url.replace(/token=[^&]+/, 'token=REDACTED'),
      error: errMsg,
    });
    throw errors.badRequest(
      `Workspace agent unreachable: ${errMsg.includes('timeout') || errMsg.includes('abort') ? 'request timed out' : 'connection failed'}`
    );
  }

  if (!res.ok) {
    const text = await res.text();
    // Log full error server-side for debugging; return sanitized message to client
    log.error('file_proxy.vm_agent_error', {
      workspaceId,
      vmPath,
      url: url.replace(/token=[^&]+/, 'token=REDACTED'),
      status: res.status,
      body: text,
    });
    // Map VM agent status codes to appropriate client responses
    if (res.status === 404) {
      throw errors.notFound('File or resource not found');
    }
    if (res.status >= 500) {
      throw errors.internal(`Workspace agent unavailable (${res.status})`);
    }
    throw errors.badRequest('VM agent returned an error');
  }

  // Guard against oversized responses
  const contentLength = parseInt(res.headers.get('Content-Length') ?? '0');
  if (contentLength > maxBytes) {
    throw errors.badRequest(`Response too large (${contentLength} bytes)`);
  }

  // Forward safe response headers from VM agent
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  // Ensure Content-Type always has a default
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(res.body, {
    status: res.status,
    headers,
  });
}

/**
 * Create a size-limited ReadableStream that aborts when the byte count exceeds maxBytes.
 */
function createSizeLimitedStream(
  source: ReadableStream<Uint8Array>,
  maxBytes: number
): ReadableStream<Uint8Array> {
  let seen = 0;
  return source.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        seen += chunk.byteLength;
        if (seen > maxBytes) {
          controller.error(new Error(`Stream exceeded size limit of ${maxBytes} bytes`));
        } else {
          controller.enqueue(chunk);
        }
      },
    })
  );
}

/**
 * Sanitize and validate the path query parameter for read-only file proxy operations.
 * Uses normalizeFileProxyPath which allows any absolute path but blocks traversal.
 */
function requireSafePath(rawPath: string | undefined): string {
  if (!rawPath) throw errors.badRequest('path query parameter is required');
  return normalizeFileProxyPath(rawPath);
}

/** GET /:id/sessions/:sessionId/files/list — Proxy directory listing */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/list', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  const params = new URLSearchParams();
  const rawPath = c.req.query('path');
  if (rawPath) params.set('path', normalizeFileProxyPath(rawPath));

  return proxyToVmAgent(c.env, workspaceUrl, workspaceId, token, 'files/list', params);
});

/** GET /:id/sessions/:sessionId/files/view — Proxy file content (via git/file on VM agent) */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/view', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  const params = new URLSearchParams();
  const path = requireSafePath(c.req.query('path'));
  params.set('path', path);

  return proxyToVmAgent(c.env, workspaceUrl, workspaceId, token, 'git/file', params);
});

/** GET /:id/sessions/:sessionId/git/status — Proxy git status */
fileProxyRoutes.get('/:id/sessions/:sessionId/git/status', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  return proxyToVmAgent(c.env, workspaceUrl, workspaceId, token, 'git/status', new URLSearchParams());
});

/** GET /:id/sessions/:sessionId/git/diff — Proxy git diff for a file */
fileProxyRoutes.get('/:id/sessions/:sessionId/git/diff', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  const params = new URLSearchParams();
  const rawPath = c.req.query('path');
  if (rawPath) params.set('path', normalizeFileProxyPath(rawPath));
  const staged = c.req.query('staged');
  if (staged === 'true' || staged === '1') params.set('staged', staged);

  return proxyToVmAgent(c.env, workspaceUrl, workspaceId, token, 'git/diff', params);
});

/** GET /:id/sessions/:sessionId/files/raw — Proxy raw binary file content */
fileProxyRoutes.get('/:id/sessions/:sessionId/files/raw', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  const params = new URLSearchParams();
  const path = requireSafePath(c.req.query('path'));
  params.set('path', path);

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

  const res = await fetch(url, {
    signal: AbortSignal.timeout(timeoutMs),
    headers: fetchHeaders,
  });

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

  // For 304, just forward the status
  if (res.status === 304) {
    return new Response(null, { status: 304 });
  }

  // Guard against oversized responses
  const contentLength = parseInt(res.headers.get('Content-Length') ?? '0');
  if (contentLength > maxBytes) {
    throw errors.badRequest(`File too large for preview (${contentLength} bytes)`);
  }

  // Forward safe response headers + security headers from VM agent
  const headers = new Headers();
  for (const name of [...FORWARDED_RESPONSE_HEADERS, ...RAW_FILE_EXTRA_HEADERS]) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/octet-stream');
  }

  // Enforce security headers independently at the proxy layer,
  // regardless of what the VM agent sends.
  headers.set('X-Content-Type-Options', 'nosniff');
  const ct = headers.get('Content-Type') ?? '';
  if (ct.startsWith('image/svg')) {
    headers.set('Content-Security-Policy', "default-src 'none'; style-src 'unsafe-inline'");
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

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  const timeoutMs = parseInt(c.env.FILE_UPLOAD_TIMEOUT_MS ?? String(DEFAULT_FILE_UPLOAD_TIMEOUT_MS));
  const maxBatchBytes = parseInt(
    c.env.FILE_UPLOAD_BATCH_MAX_BYTES ?? String(DEFAULT_FILE_UPLOAD_BATCH_MAX_BYTES)
  );

  // Pre-check Content-Length if present
  const contentLength = parseInt(c.req.header('Content-Length') ?? '0');
  if (contentLength > maxBatchBytes + 1024 * 1024) {
    throw errors.badRequest(`Upload too large (${contentLength} bytes)`);
  }

  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/upload?token=${encodeURIComponent(token)}`;

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': c.req.header('Content-Type') ?? 'multipart/form-data',
    },
    body: c.req.raw.body
      ? createSizeLimitedStream(c.req.raw.body, maxBatchBytes + 1024 * 1024)
      : undefined,
    signal: AbortSignal.timeout(timeoutMs),
    // @ts-expect-error duplex is required for streaming request bodies in fetch
    duplex: 'half',
  });

  if (!res.ok) {
    const text = await res.text();
    log.error('file_proxy.upload_error', {
      workspaceId,
      status: res.status,
      body: text,
    });
    const clientStatus =
      res.status === 413 ? 413 : res.status >= 500 ? 502 : 400;
    if (clientStatus === 502) throw errors.internal('Workspace agent unavailable');
    throw errors.badRequest(
      clientStatus === 413 ? 'File too large' : 'Upload failed'
    );
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

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  const filePath = c.req.query('path');
  if (!filePath) throw errors.badRequest('path query parameter is required');
  const safePath = normalizeFileProxyPath(filePath);

  const timeoutMs = parseInt(c.env.FILE_DOWNLOAD_TIMEOUT_MS ?? String(DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS));
  const maxBytes = parseInt(
    c.env.FILE_DOWNLOAD_MAX_BYTES ?? String(DEFAULT_FILE_DOWNLOAD_MAX_BYTES)
  );

  const params = new URLSearchParams({ path: safePath, token });
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/files/download?${params.toString()}`;

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });

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

  return new Response(
    res.body ? createSizeLimitedStream(res.body, maxBytes) : null,
    { status: res.status, headers }
  );
});

export { fileProxyRoutes };
