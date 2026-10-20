/**
 * Session file proxy plumbing: resolve a chat session's workspace on the VM agent and proxy a
 * request to it. Split out of `files.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { requireProjectAccess } from '../../middleware/project-auth';
import { signTerminalToken } from '../../services/jwt';
import { fetchNodeAgent } from '../../services/node-agent';
import * as projectDataService from '../../services/project-data';

/** Default timeout for VM agent proxy requests (configurable via FILE_PROXY_TIMEOUT_MS). */
export const DEFAULT_FILE_PROXY_TIMEOUT_MS = 15_000;
/** Default max response size from VM agent (configurable via FILE_PROXY_MAX_RESPONSE_BYTES). */
export const DEFAULT_FILE_PROXY_MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB
/** Default max response size for raw binary file proxy (configurable via FILE_RAW_PROXY_MAX_BYTES). */
export const DEFAULT_FILE_RAW_PROXY_MAX_BYTES = 50 * 1024 * 1024; // 50 MB
/** Default max batch upload size (configurable via FILE_UPLOAD_BATCH_MAX_BYTES). */
export const DEFAULT_FILE_UPLOAD_BATCH_MAX_BYTES = 250 * 1024 * 1024; // 250 MB
/** Default timeout for upload proxy requests (configurable via FILE_UPLOAD_TIMEOUT_MS). */
export const DEFAULT_FILE_UPLOAD_TIMEOUT_MS = 120_000;
/** Default timeout for download proxy requests (configurable via FILE_DOWNLOAD_TIMEOUT_MS). */
export const DEFAULT_FILE_DOWNLOAD_TIMEOUT_MS = 60_000;
/** Default max file download size (configurable via FILE_DOWNLOAD_MAX_BYTES). */
export const DEFAULT_FILE_DOWNLOAD_MAX_BYTES = 50 * 1024 * 1024; // 50 MB

/** Response headers safe to forward from VM agent to the client. */
export const FORWARDED_RESPONSE_HEADERS = [
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
export async function resolveSessionWorkspace(
  env: Env,
  projectId: string,
  sessionId: string,
  userId: string
) {
  const db = drizzle(env.DATABASE, { schema });

  // Verify project ownership
  await requireProjectAccess(db, projectId, userId);

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
    throw errors.badRequest(`Workspace is not accessible (status: ${workspace.status})`);
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

  return { workspaceUrl, workspaceId: workspace.id, nodeId: workspace.nodeId, token };
}

/**
 * Proxy a request to the VM agent, forwarding query params and returning the response.
 * Token is passed via query param (VM agent's requireWorkspaceRequestAuth expects this).
 */
export async function proxyToVmAgent(
  env: Env,
  nodeId: string,
  workspaceUrl: string,
  workspaceId: string,
  token: string,
  vmPath: string,
  queryParams: URLSearchParams
): Promise<Response> {
  const timeoutMs = parseInt(env.FILE_PROXY_TIMEOUT_MS ?? String(DEFAULT_FILE_PROXY_TIMEOUT_MS));
  const maxBytes = parseInt(
    env.FILE_PROXY_MAX_RESPONSE_BYTES ?? String(DEFAULT_FILE_PROXY_MAX_RESPONSE_BYTES)
  );

  queryParams.set('token', token);
  const url = `${workspaceUrl}/workspaces/${encodeURIComponent(workspaceId)}/${vmPath}?${queryParams.toString()}`;

  let res: Response;
  try {
    res = await fetchNodeAgent(nodeId, env, url, {}, timeoutMs);
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
export function createSizeLimitedStream(
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
