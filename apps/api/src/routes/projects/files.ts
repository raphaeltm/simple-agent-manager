import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { signTerminalToken } from '../../services/jwt';
import { normalizeFileProxyPath } from './_helpers';

const fileProxyRoutes = new Hono<{ Bindings: Env }>();

/** Default timeout for VM agent proxy requests (configurable via FILE_PROXY_TIMEOUT_MS). */
const DEFAULT_FILE_PROXY_TIMEOUT_MS = 15_000;
/** Default max response size from VM agent (configurable via FILE_PROXY_MAX_RESPONSE_BYTES). */
const DEFAULT_FILE_PROXY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

/** Response headers safe to forward from VM agent to the client. */
const FORWARDED_RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
  'Content-Disposition',
  'Cache-Control',
  'ETag',
  'Last-Modified',
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

  // Find workspace linked to this chat session
  const workspaces = await db
    .select({
      id: schema.workspaces.id,
      status: schema.workspaces.status,
      projectId: schema.workspaces.projectId,
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

  const workspace = workspaces[0];
  if (!workspace) {
    throw errors.notFound('No workspace found for this session');
  }

  // Defensive assertion: workspace must belong to the expected project
  if (workspace.projectId !== projectId) {
    throw errors.forbidden('Workspace does not belong to this project');
  }

  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    throw errors.badRequest(
      `Workspace is not accessible (status: ${workspace.status})`
    );
  }

  const workspaceUrl = `https://ws-${workspace.id}.${env.BASE_DOMAIN}`;
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

  const res = await fetch(url, { signal: AbortSignal.timeout(timeoutMs) });
  if (!res.ok) {
    const text = await res.text();
    // Log full error server-side for debugging; return sanitized message to client
    console.error(
      JSON.stringify({
        event: 'file_proxy.vm_agent_error',
        workspaceId,
        vmPath,
        status: res.status,
        body: text,
      })
    );
    // Map VM agent status codes to appropriate client responses
    const clientStatus =
      res.status === 404 ? 404 : res.status >= 500 ? 502 : 400;
    throw errors.badRequest(
      clientStatus === 404
        ? 'File or resource not found'
        : clientStatus === 502
          ? 'Workspace agent unavailable'
          : 'VM agent request failed'
    );
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
  const path = requireSafePath(c.req.query('path'));
  params.set('path', path);
  const staged = c.req.query('staged');
  if (staged) params.set('staged', staged);

  return proxyToVmAgent(c.env, workspaceUrl, workspaceId, token, 'git/diff', params);
});

export { fileProxyRoutes };
