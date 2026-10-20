/**
 * Session file proxy plumbing: resolve a chat session's workspace on the VM agent and proxy a
 * request to it. Split out of `files.ts` (`.claude/rules/18-file-size-limits.md`).
 */
import { and, eq, sql } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/d1';

import * as schema from '../../db/schema';
import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { errors } from '../../middleware/error';
import { requireProjectAccess } from '../../middleware/project-auth';
import { signTerminalToken } from '../../services/jwt';
import { fetchNodeAgent } from '../../services/node-agent';
import * as projectDataService from '../../services/project-data';
import { requireSessionWriter } from '../../services/session-access';

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
 * A teammate reading a chat shared with them (idea 01M59MYE4GY91BWTE8TZF1ZB5D). Every read is
 * confined to the repository working tree by the VM agent, and nothing is returned unless the
 * agent confirms it (`requireConfinedResponse`).
 */
export interface SharedWorkspaceReader {
  actorUserId: string;
  ownerUserId: string;
  grantId: string;
}

export interface SessionWorkspace {
  workspaceUrl: string;
  workspaceId: string;
  nodeId: string;
  /** For this request only; never returned to the browser. */
  token: string;
  /** Set when a teammate the chat is shared with is reading; null for the workspace owner. */
  sharedReader: SharedWorkspaceReader | null;
}

/** The VM agent's answer that it confined a request to the working tree. */
export const PATH_CONFINEMENT_HEADER = 'X-SAM-Path-Confinement';
export const PATH_CONFINEMENT_WORKDIR = 'workdir';

const WORKSPACE_COLUMNS = {
  id: schema.workspaces.id,
  status: schema.workspaces.status,
  projectId: schema.workspaces.projectId,
  nodeId: schema.workspaces.nodeId,
  userId: schema.workspaces.userId,
};

/**
 * Resolve a chat session's workspace on the VM agent and sign a token for this request.
 *
 * The workspace's owner reads it as before. With `allowSharedReader`, a teammate the chat is
 * shared with reads the owner's workspace: `requireSessionWriter` re-checks their grant, and
 * both people's membership, on every request, so expiry and revoke end access at the next one.
 */
export async function resolveSessionWorkspace(
  env: Env,
  projectId: string,
  sessionId: string,
  userId: string,
  options: { allowSharedReader?: boolean; action?: string } = {}
): Promise<SessionWorkspace> {
  const db = drizzle(env.DATABASE, { schema });

  // Verify project ownership
  await requireProjectAccess(db, projectId, userId);

  // Strategy 1: Find workspace by chatSessionId in D1 (canonical path). The caller's own
  // workspace sorts first; any other row is a teammate's candidate, checked below.
  const linked = await db
    .select(WORKSPACE_COLUMNS)
    .from(schema.workspaces)
    .where(
      and(
        eq(schema.workspaces.chatSessionId, sessionId),
        eq(schema.workspaces.projectId, projectId)
      )
    )
    .orderBy(sql`(${schema.workspaces.userId} = ${userId}) DESC`)
    .limit(1);

  let workspace = linked[0]?.userId === userId ? linked[0] : undefined;
  let lookupStrategy = workspace ? 'chatSessionId' : 'none';
  let sharedReader: SharedWorkspaceReader | null = null;

  // Strategy 2: Fall back to the session's workspaceId from the ProjectData DO.
  // This handles the case where chatSessionId was not written to D1 (e.g., DO
  // crash during workspace creation left the link incomplete). A linked row of someone else's
  // means the link was written, so there is nothing to fall back to.
  if (!workspace && !linked[0]) {
    const session = await projectDataService.getSession(env, projectId, sessionId);
    const raw = session?.workspaceId;
    const sessionWorkspaceId = typeof raw === 'string' && raw.length > 0 ? raw : undefined;
    if (sessionWorkspaceId) {
      const fallbackWorkspaces = await db
        .select(WORKSPACE_COLUMNS)
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

  // Not the caller's workspace: a teammate the chat is shared with reads its owner's, found
  // by the chat link alone. A teammate's read costs 8 round trips: project access (the project
  // and the membership), the link, the grant read and two membership checks, the node's runtime
  // and the VM agent.
  const candidate = linked[0];
  if (!workspace && options.allowSharedReader && candidate) {
    const writer = await requireSessionWriter(env, projectId, sessionId, userId, {
      db,
      action: options.action ?? 'read files in this session',
    });
    if (writer.role === 'grantee' && writer.grantId && writer.ownerUserId === candidate.userId) {
      workspace = candidate;
      lookupStrategy = 'shared-access';
      sharedReader = {
        actorUserId: userId,
        ownerUserId: writer.ownerUserId,
        grantId: writer.grantId,
      };
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
    ...(sharedReader ?? {}),
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
  // The workspace's owner, also for a teammate: the token selects the owner's resource.
  const { token } = await signTerminalToken(workspace.userId, workspace.id, env);

  return {
    workspaceUrl,
    workspaceId: workspace.id,
    nodeId: workspace.nodeId,
    token,
    sharedReader,
  };
}

/**
 * Ask the VM agent to confine a teammate's request to the working tree, and record the read.
 * The owner's requests are unchanged. A teammate's path must be relative; the agent enforces
 * the rest.
 */
export function confineForSharedReader(
  target: SessionWorkspace,
  vmPath: string,
  params: URLSearchParams,
  path?: string
): void {
  if (!target.sharedReader) return;
  if (path !== undefined && (path.startsWith('/') || path.startsWith('~'))) {
    throw errors.notFound('File or resource');
  }
  params.set('confine', PATH_CONFINEMENT_WORKDIR);
  log.info('file_proxy.shared_read', {
    workspaceId: target.workspaceId,
    vmPath,
    path: path ?? null,
    ...target.sharedReader,
  });
}

/**
 * A teammate gets nothing from an agent that did not confirm the confinement: an agent that
 * predates it would have read the path as given.
 */
export async function requireConfinedResponse(
  target: SessionWorkspace,
  res: Response,
  vmPath: string
): Promise<void> {
  if (!target.sharedReader) return;
  if (res.headers.get(PATH_CONFINEMENT_HEADER) === PATH_CONFINEMENT_WORKDIR) return;
  await res.body?.cancel();
  log.warn('file_proxy.confinement_unsupported', {
    workspaceId: target.workspaceId,
    vmPath,
    status: res.status,
    ...target.sharedReader,
  });
  throw errors.conflict(
    'This workspace runs an older agent that cannot limit files to the repository. Teammates can browse files after it restarts.'
  );
}

/**
 * Proxy a request to the VM agent, forwarding query params and returning the response.
 * Token is passed via query param (VM agent's requireWorkspaceRequestAuth expects this).
 */
export async function proxyToVmAgent(
  env: Env,
  target: SessionWorkspace,
  vmPath: string,
  queryParams: URLSearchParams
): Promise<Response> {
  const { nodeId, workspaceUrl, workspaceId, token } = target;
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

  await requireConfinedResponse(target, res, vmPath);

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
