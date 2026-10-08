import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Env } from '../../env';
import { errors } from '../../middleware/error';
import {
  LIFECYCLE_TIMINGS_MAX_BYTES,
  recordLifecycleTimings,
} from '../../services/lifecycle-timings';
import { nodeStatusTerminatesCallbacks } from '../../services/node-callback-auth';
import { loadWorkspaceCallbackIdentity, verifyWorkspaceCallbackAuth } from './_helpers';

export const lifecycleTimingsRoutes = new Hono<{ Bindings: Env }>();
// Callback JWT only. No session-cookie middleware or telemetry persistence.
lifecycleTimingsRoutes.post(
  '/:id/lifecycle-timings',
  bodyLimit({
    maxSize: LIFECYCLE_TIMINGS_MAX_BYTES,
    onError: (c) =>
      c.json({ error: 'PAYLOAD_TOO_LARGE', message: 'Lifecycle timing summary is too large' }, 413),
  }),
  async (c) => {
    const workspaceId = c.req.param('id');
    await verifyWorkspaceCallbackAuth(c, workspaceId);
    const workspace = await loadWorkspaceCallbackIdentity(c.env, workspaceId);
    if (
      !workspace ||
      !workspace.nodeId ||
      !workspace.nodeStatus ||
      nodeStatusTerminatesCallbacks(workspace.nodeStatus) ||
      !['creating', 'running', 'recovery', 'stopping'].includes(workspace.status)
    ) {
      throw errors.gone('Workspace is no longer active');
    }
    const body: unknown = await c.req.json().catch(() => {
      throw errors.badRequest('Invalid lifecycle timing JSON');
    });
    if (!body || typeof body !== 'object' || !('operation' in body) || !('phases' in body)) {
      throw errors.badRequest('Invalid lifecycle timing summary');
    }
    const operation = body.operation;
    if (operation !== 'workspace' && operation !== 'sleep' && operation !== 'wake') {
      throw errors.badRequest('Invalid lifecycle operation');
    }
    recordLifecycleTimings(
      operation,
      body.phases,
      { workspaceId, nodeId: workspace.nodeId, chatSessionId: workspace.chatSessionId },
      'outcome' in body && body.outcome === 'error' ? 'error' : 'success'
    );
    return c.json({ accepted: true });
  }
);
