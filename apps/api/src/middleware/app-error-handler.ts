import type { Context } from 'hono';
import type { ContentfulStatusCode } from 'hono/utils/http-status';

import type { Env } from '../env';
import { log, serializeError } from '../lib/logger';
import { GcpApiError, sanitizeGcpError } from '../services/gcp-errors';
import { persistError, redactSensitiveData } from '../services/observability';
import { AppError } from './error';

type AppContext = Context<{ Bindings: Env }>;

interface RequestIdentifiers {
  nodeId?: string;
  workspaceId?: string;
  taskId?: string;
  sessionId?: string;
  projectId?: string;
}

const BENIGN_DISCONNECT_PATHS = new Set([
  '/api/notifications/ws',
  '/api/admin/observability/logs/ingest',
]);

function isBenignDisconnect(err: Error, path: string): boolean {
  if (!BENIGN_DISCONNECT_PATHS.has(path)) return false;
  const message = err.message.toLowerCase();
  return (
    message === 'network connection lost.' ||
    message.includes('network connection lost') ||
    message.includes('client disconnected') ||
    message.includes('canceled') ||
    message.includes('cancelled')
  );
}

function requestIdentifiers(c: AppContext): RequestIdentifiers {
  const params = c.req.param() as Record<string, string>;
  const path = new URL(c.req.url).pathname;
  return {
    nodeId: params.nodeId ?? (path.startsWith('/api/nodes/') ? params.id : undefined),
    workspaceId:
      params.workspaceId ?? (path.startsWith('/api/workspaces/') ? params.id : undefined),
    taskId: params.taskId,
    sessionId: params.sessionId,
    projectId: params.projectId,
  };
}

/** Schedule best-effort error persistence without allowing the error path to throw. */
function scheduleErrorPersistence(
  c: AppContext,
  err: Error,
  status: number,
  requestId: string
): void {
  try {
    if (!c.env.OBSERVABILITY_DATABASE) return;
    const identifiers = requestIdentifiers(c);
    const auth = c.get('auth') as { user?: { id?: string } } | undefined;
    const safe = redactSensitiveData({
      message: err.message || 'Unhandled API error',
      stack: err.stack ?? null,
      context: {
        requestId,
        path: new URL(c.req.url).pathname,
        method: c.req.method,
        status,
        ...identifiers,
      },
    });
    const persistence = persistError(
      c.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: safe.message,
        stack: safe.stack,
        context: safe.context,
        userId: auth?.user?.id ?? null,
        nodeId: identifiers.nodeId ?? null,
        workspaceId: identifiers.workspaceId ?? null,
        taskId: identifiers.taskId ?? null,
        sessionId: identifiers.sessionId ?? null,
        ipAddress: c.req.header('CF-Connecting-IP') ?? null,
        userAgent: c.req.header('User-Agent') ?? null,
      },
      c.env
    ).catch(() => undefined);
    try {
      c.executionCtx.waitUntil(persistence);
    } catch {
      // The response path remains authoritative even if waitUntil is unavailable.
    }
  } catch {
    // Recording an error must never throw, recurse, or replace the original response.
  }
}

/** Global Hono error handler shared by the production Worker and worker integration tests. */
export function handleAppError(err: Error, c: AppContext): Response {
  const path = new URL(c.req.url).pathname;
  if (isBenignDisconnect(err, path)) {
    log.warn('request_disconnected', {
      path,
      method: c.req.method,
      error: err.message,
    });
    return new Response(null, { status: 204 });
  }

  let status: number;
  let body: Record<string, unknown>;

  if (err instanceof AppError) {
    status = err.statusCode;
    body = { ...err.toJSON() };
  } else if (err instanceof GcpApiError) {
    status = 502;
    body = {
      error: 'GCP_UPSTREAM_ERROR',
      message: sanitizeGcpError(err, 'global-handler'),
    };
  } else {
    status = 500;
    body = { error: 'INTERNAL_ERROR', message: 'Internal server error' };
  }

  if (status < 500) {
    if (status === 401 || status === 410) {
      log.info('request_rejected', { status, ...serializeError(err) });
    } else {
      log.warn('request_rejected', { status, ...serializeError(err) });
    }
    return c.json(body, status as ContentfulStatusCode);
  }

  const requestId = crypto.randomUUID();
  log.error('request_error', { requestId, status, ...serializeError(err) });
  scheduleErrorPersistence(c, err, status, requestId);
  return c.json({ ...body, requestId }, status as ContentfulStatusCode);
}
