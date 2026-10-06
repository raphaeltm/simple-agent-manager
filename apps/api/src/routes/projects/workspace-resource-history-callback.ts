import { Hono } from 'hono';

import type { Env } from '../../env';
import { extractBearerToken } from '../../lib/auth-helpers';
import {
  readRequestJsonWithSchema,
  RequestBodyTooLargeError,
  RuntimeValidationError,
} from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import { WorkspaceResourceUploadSchema } from '../../schemas';
import { type CallbackTokenPayload, verifyCallbackToken } from '../../services/jwt';
import { callbackTokenMatchesNode } from '../../services/node-callback-auth';
import {
  getWorkspaceResourceUploadMaxBytes,
  storeWorkspaceResourceChunk,
  type WorkspaceResourceUploadBody,
} from '../../services/workspace-resource-history';

/**
 * Workspace resource telemetry upload route — mounted BEFORE projectsRoutes in index.ts
 * because VM agents authenticate with callback JWTs, not browser session cookies.
 */
const workspaceResourceHistoryCallbackRoute = new Hono<{ Bindings: Env }>();

function callbackTokenMatchesWorkspaceOrLegacy(
  payload: CallbackTokenPayload,
  workspaceId: string
): boolean {
  return (
    (payload.scope === 'workspace' || payload.scope === undefined) &&
    payload.workspace === workspaceId
  );
}

function authorizedUploader(
  payload: CallbackTokenPayload,
  body: WorkspaceResourceUploadBody
): string | null {
  if (payload.scope === 'node') {
    if (!callbackTokenMatchesNode(payload, body.nodeId)) {
      throw errors.forbidden('Callback token is not authorized for this node');
    }
    return payload.workspace;
  }

  if (callbackTokenMatchesWorkspaceOrLegacy(payload, body.workspaceId)) {
    return null;
  }

  throw errors.forbidden('Callback token is not authorized for this workspace');
}

async function readUploadBody(request: Request, env: Env): Promise<WorkspaceResourceUploadBody> {
  try {
    const requestMaxBytes = getWorkspaceResourceUploadMaxBytes(env) * 2 + 64 * 1024;
    return await readRequestJsonWithSchema(
      WorkspaceResourceUploadSchema,
      request,
      'workspace-resource-history-upload',
      requestMaxBytes
    );
  } catch (error) {
    if (error instanceof RequestBodyTooLargeError) {
      throw errors.badRequest(error.message);
    }
    if (error instanceof RuntimeValidationError) {
      throw errors.badRequest(error.message);
    }
    throw error;
  }
}

workspaceResourceHistoryCallbackRoute.post('/:id/workspace-resource-history', async (c) => {
  const projectId = c.req.param('id');
  const token = extractBearerToken(c.req.header('Authorization'));
  const payload = await verifyCallbackToken(token, c.env);
  const body = await readUploadBody(c.req.raw, c.env);
  const uploadedByNodeId = authorizedUploader(payload, body);
  const result = await storeWorkspaceResourceChunk(c.env, projectId, body, uploadedByNodeId);
  return c.json({
    summaryId: result.summaryId,
    chunkId: result.chunkId,
    idempotent: result.idempotent,
  });
});

export { workspaceResourceHistoryCallbackRoute };
