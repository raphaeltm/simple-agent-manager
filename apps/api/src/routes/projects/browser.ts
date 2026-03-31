import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { signTerminalToken } from '../../services/jwt';
import * as projectDataService from '../../services/project-data';

const browserProxyRoutes = new Hono<{ Bindings: Env }>();

/** Default timeout for browser sidecar proxy requests (configurable via BROWSER_PROXY_TIMEOUT_MS). */
const DEFAULT_BROWSER_PROXY_TIMEOUT_MS = 30_000;

/** Response headers safe to forward from VM agent. */
const FORWARDED_RESPONSE_HEADERS = [
  'Content-Type',
  'Content-Length',
];

/**
 * Resolve workspace from a chat session and build the VM agent URL + token.
 * Same pattern as file proxy (files.ts) — looks up workspace by chatSessionId in D1.
 */
async function resolveSessionWorkspace(
  env: Env,
  projectId: string,
  sessionId: string,
  userId: string
) {
  const db = drizzle(env.DATABASE, { schema });

  await requireOwnedProject(db, projectId, userId);

  // Strategy 1: Find workspace by chatSessionId in D1
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

  // Strategy 2: Fall back to the session's workspaceId from the ProjectData DO.
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
    }
  }

  if (!workspace) {
    throw errors.notFound('Workspace');
  }

  if (workspace.projectId !== projectId) {
    throw errors.forbidden('Workspace does not belong to this project');
  }

  if (workspace.status !== 'running' && workspace.status !== 'recovery') {
    throw errors.badRequest(
      `Workspace is not accessible (status: ${workspace.status})`
    );
  }

  if (!workspace.nodeId) {
    throw errors.badRequest('Workspace has no assigned node');
  }

  const protocol = env.VM_AGENT_PROTOCOL || 'https';
  const port = env.VM_AGENT_PORT || '8443';
  const workspaceUrl = `${protocol}://${workspace.nodeId.toLowerCase()}.vm.${env.BASE_DOMAIN}:${port}`;
  const { token } = await signTerminalToken(userId, workspace.id, env);

  return { workspaceUrl, workspaceId: workspace.id, token };
}

/**
 * Proxy a request to the VM agent's browser sidecar endpoint.
 */
async function proxyBrowserRequest(
  env: Env,
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  vmPath: string,
  method: string,
  body?: ReadableStream<Uint8Array> | null,
  contentType?: string
): Promise<Response> {
  const rawTimeout = parseInt(env.BROWSER_PROXY_TIMEOUT_MS ?? '');
  const timeoutMs = Number.isFinite(rawTimeout) && rawTimeout > 0
    ? rawTimeout
    : DEFAULT_BROWSER_PROXY_TIMEOUT_MS;

  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/${vmPath}?token=${encodeURIComponent(token)}`;

  const fetchOpts: RequestInit = {
    method,
    signal: AbortSignal.timeout(timeoutMs),
  };

  if (body && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    fetchOpts.body = body;
    fetchOpts.headers = { 'Content-Type': contentType || 'application/json' };
    // @ts-expect-error — duplex required for streaming bodies in Workers/Node 18+
    fetchOpts.duplex = 'half';
  }

  let res: Response;
  try {
    res = await fetch(url, fetchOpts);
  } catch (fetchErr) {
    const errMsg = fetchErr instanceof Error ? fetchErr.message : String(fetchErr);
    console.error(
      JSON.stringify({
        event: 'browser_proxy.fetch_error',
        workspaceId,
        vmPath,
        url: url.replace(/token=[^&]+/, 'token=REDACTED'),
        error: errMsg,
      })
    );
    throw errors.badRequest(
      `Workspace agent unreachable: ${errMsg.includes('timeout') || errMsg.includes('abort') ? 'request timed out' : 'connection failed'}`
    );
  }

  if (!res.ok) {
    const text = await res.text();
    console.error(
      JSON.stringify({
        event: 'browser_proxy.vm_agent_error',
        workspaceId,
        vmPath,
        status: res.status,
        body: text,
      })
    );
    if (res.status === 404) {
      throw errors.notFound('Browser sidecar not found');
    }
    if (res.status >= 500) {
      throw errors.internal(`Workspace agent unavailable (${res.status})`);
    }
    throw errors.badRequest('VM agent returned an error');
  }

  // Forward safe headers
  const headers = new Headers();
  for (const name of FORWARDED_RESPONSE_HEADERS) {
    const value = res.headers.get(name);
    if (value) headers.set(name, value);
  }
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json');
  }

  return new Response(res.body, { status: res.status, headers });
}

// POST /:id/sessions/:sessionId/browser — start browser sidecar
browserProxyRoutes.post('/:id/sessions/:sessionId/browser', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  return proxyBrowserRequest(
    c.env,
    workspaceUrl,
    workspaceId,
    token,
    'browser',
    'POST',
    c.req.raw.body,
    c.req.header('Content-Type')
  );
});

// GET /:id/sessions/:sessionId/browser — get browser sidecar status
browserProxyRoutes.get('/:id/sessions/:sessionId/browser', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  return proxyBrowserRequest(
    c.env,
    workspaceUrl,
    workspaceId,
    token,
    'browser',
    'GET'
  );
});

// DELETE /:id/sessions/:sessionId/browser — stop browser sidecar
browserProxyRoutes.delete('/:id/sessions/:sessionId/browser', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  return proxyBrowserRequest(
    c.env,
    workspaceUrl,
    workspaceId,
    token,
    'browser',
    'DELETE'
  );
});

// GET /:id/sessions/:sessionId/browser/ports — list active socat forwarders
browserProxyRoutes.get('/:id/sessions/:sessionId/browser/ports', async (c) => {
  const userId = getUserId(c);
  const projectId = c.req.param('id');
  const sessionId = c.req.param('sessionId');

  const { workspaceUrl, workspaceId, token } = await resolveSessionWorkspace(
    c.env,
    projectId,
    sessionId,
    userId
  );

  return proxyBrowserRequest(
    c.env,
    workspaceUrl,
    workspaceId,
    token,
    'browser/ports',
    'GET'
  );
});

export { browserProxyRoutes };
