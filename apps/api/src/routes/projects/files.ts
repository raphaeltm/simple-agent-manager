import { Hono } from 'hono';
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';
import type { Env } from '../../index';
import * as schema from '../../db/schema';
import { getUserId } from '../../middleware/auth';
import { errors } from '../../middleware/error';
import { requireOwnedProject } from '../../middleware/project-auth';
import { signTerminalToken } from '../../services/jwt';

const fileProxyRoutes = new Hono<{ Bindings: Env }>();

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
 */
async function proxyToVmAgent(
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  vmPath: string,
  queryParams: URLSearchParams
): Promise<Response> {
  queryParams.set('token', token);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/${vmPath}?${queryParams.toString()}`;

  const res = await fetch(url);
  if (!res.ok) {
    const text = await res.text();
    throw errors.badRequest(`VM agent error: ${text}`);
  }

  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': res.headers.get('Content-Type') ?? 'application/json' },
  });
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
  const path = c.req.query('path');
  if (path) params.set('path', path);

  return proxyToVmAgent(workspaceUrl, workspaceId, token, 'files/list', params);
});

/** GET /:id/sessions/:sessionId/files/view — Proxy file content */
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
  const path = c.req.query('path');
  if (!path) throw errors.badRequest('path query parameter is required');
  params.set('path', path);

  return proxyToVmAgent(workspaceUrl, workspaceId, token, 'git/file', params);
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

  return proxyToVmAgent(workspaceUrl, workspaceId, token, 'git/status', new URLSearchParams());
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
  const path = c.req.query('path');
  if (!path) throw errors.badRequest('path query parameter is required');
  params.set('path', path);
  const staged = c.req.query('staged');
  if (staged) params.set('staged', staged);

  return proxyToVmAgent(workspaceUrl, workspaceId, token, 'git/diff', params);
});

export { fileProxyRoutes };
