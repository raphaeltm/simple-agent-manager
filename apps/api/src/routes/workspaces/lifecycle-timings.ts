import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';

import type { Env } from '../../env';
import { log } from '../../lib/logger';
import { maybeJsonRecord } from '../../lib/runtime-validation';
import { errors } from '../../middleware/error';
import {
  boundedLifecycleTimings,
  LIFECYCLE_TIMINGS_MAX_BYTES,
  recordLifecycleTimings,
} from '../../services/lifecycle-timings';
import { nodeStatusTerminatesCallbacks } from '../../services/node-callback-auth';
import { recordSessionSnapshotTrace } from '../../services/session-snapshot-traces';
import { loadWorkspaceCallbackIdentity, verifyWorkspaceCallbackAuth } from './_helpers';

type CallbackWorkspace = NonNullable<Awaited<ReturnType<typeof loadWorkspaceCallbackIdentity>>>;

/**
 * Persist a sleep/wake step trace. The chat comes from the workspace row, not the body: a body
 * `chatSessionId` (newer agents) must agree with it, and an older agent that sends none still
 * gets its phase timings recorded.
 */
async function recordSnapshotTraceForCallback(
  env: Env,
  workspace: CallbackWorkspace,
  input: {
    operation: 'sleep' | 'wake';
    outcome: 'success' | 'error';
    body: Record<string, unknown>;
  }
): Promise<void> {
  const chatSessionId = workspace.chatSessionId;
  if (!chatSessionId) return;
  const claimed = input.body.chatSessionId;
  if (claimed !== undefined && claimed !== chatSessionId) {
    log.warn('session_snapshot_trace.session_mismatch', {
      workspaceId: workspace.workspaceId,
      expectedChatSessionId: chatSessionId,
      receivedChatSessionId: typeof claimed === 'string' ? claimed : null,
      action: 'dropped',
    });
    return;
  }
  const phases = boundedLifecycleTimings(input.body.phases);
  if (phases.length === 0 && input.outcome === 'success') return;
  await recordSessionSnapshotTrace(env, {
    chatSessionId,
    projectId: workspace.projectId,
    workspaceId: workspace.workspaceId,
    nodeId: workspace.nodeId,
    operation: input.operation,
    outcome: input.outcome,
    phases,
    failedPhase: input.body.failedPhase,
    errorTail: input.body.errorTail,
  });
}

export const lifecycleTimingsRoutes = new Hono<{ Bindings: Env }>();
// Callback JWT only, no session-cookie middleware. Sleep/wake summaries persist a bounded
// step trace (session_snapshot_traces); provisioning summaries are log-only.
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
    const outcome = 'outcome' in body && body.outcome === 'error' ? 'error' : 'success';
    recordLifecycleTimings(
      operation,
      body.phases,
      { workspaceId, nodeId: workspace.nodeId, chatSessionId: workspace.chatSessionId },
      outcome
    );
    if (operation !== 'workspace') {
      await recordSnapshotTraceForCallback(c.env, workspace, {
        operation,
        outcome,
        // The optional trace fields are read defensively by the trace writer (rule 54).
        body: maybeJsonRecord(body) ?? {},
      });
    }
    return c.json({ accepted: true });
  }
);
