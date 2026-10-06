import type { Context } from 'hono';

import type { Env } from '../env';
import { log } from '../lib/logger';
import { getAuth } from '../middleware/auth';
import { persistError } from '../services/observability';

export type ChatSessionLoadPhase = 'get_session' | 'get_messages';

function isDiagnosticRole(role: string): boolean {
  return role === 'admin' || role === 'superadmin';
}

function serializeDiagnosticError(err: unknown): {
  name: string;
  message: string;
  stack: string | null;
} {
  if (err instanceof Error) {
    return {
      name: err.name,
      message: err.message,
      stack: err.stack ?? null,
    };
  }

  return {
    name: 'NonError',
    message: String(err),
    stack: null,
  };
}

export async function recordChatSessionLoadFailure(
  c: Context<{ Bindings: Env }>,
  input: {
    err: unknown;
    phase: ChatSessionLoadPhase;
    projectId: string;
    sessionId: string;
    userId: string;
  }
): Promise<Response> {
  const requestId = crypto.randomUUID();
  const diagnostic = serializeDiagnosticError(input.err);
  const context = {
    requestId,
    route: 'GET /api/projects/:projectId/sessions/:sessionId',
    phase: input.phase,
    projectId: input.projectId,
    sessionId: input.sessionId,
    userId: input.userId,
    errorName: diagnostic.name,
    errorMessage: diagnostic.message,
  };

  log.error('chat.session_detail_load_failed', {
    ...context,
    stack: diagnostic.stack,
  });

  if (c.env.OBSERVABILITY_DATABASE) {
    await persistError(
      c.env.OBSERVABILITY_DATABASE,
      {
        source: 'api',
        level: 'error',
        message: 'chat.session_detail_load_failed',
        stack: diagnostic.stack,
        context,
        userId: input.userId,
        sessionId: input.sessionId,
        ipAddress: c.req.header('CF-Connecting-IP') ?? null,
        userAgent: c.req.header('User-Agent') ?? null,
      },
      c.env
    );
  }

  const body: Record<string, unknown> = {
    error: 'CHAT_SESSION_LOAD_FAILED',
    message: 'Failed to load chat session',
    requestId,
    phase: input.phase,
  };

  if (isDiagnosticRole(getAuth(c).user.role)) {
    body.details = {
      errorName: diagnostic.name,
      errorMessage: diagnostic.message,
      stack: diagnostic.stack,
    };
  }

  return c.json(body, 500);
}
