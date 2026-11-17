import { MESSAGE_OUTBOX_INCARNATION_HEADER } from '@simple-agent-manager/shared';


import { type Context, Hono } from 'hono';
import * as v from 'valibot';


import type { Env } from '../../env';



















import * as projectDataService from '../../services/project-data';




import { signalWorkspaceDeletionUnconfirmedCallback } from '../../services/workspace-deletion-callback-signal';



import { sameWorkspaceCallbackIdentity, verifyWorkspaceCallbackAuth } from './_helpers';


import { type MessageBatchPersistenceRouteResult, type MessageRouteContext, parseMessageBatchRequest, validateMessageBatch, loadMessageWorkspace, terminalMessagePersistenceResponse, maybeTerminalMessageWorkspaceResponse, assertMessageWorkspaceAcceptsBatch, toProjectDataMessages, handleMessagePersistenceError, partialSessionLimitResponse } from './runtime-message-helpers';
const runtimeRoutes = new Hono<{ Bindings: Env }>();
type RuntimeContext = Context<{ Bindings: Env }>;
runtimeRoutes.post('/:id/messages', async (c) => {
  const workspaceId = c.req.param('id');
  await verifyWorkspaceCallbackAuth(c, workspaceId);

  // Authenticate and resolve terminal state before reading an untrusted body.
  // Late deletion callbacks are discarded without parsing or persisting payloads.
  const workspace = await loadMessageWorkspace(c.env, workspaceId);
  const preflightTerminalResponse = maybeTerminalMessageWorkspaceResponse(
    c,
    workspace,
    workspaceId,
    '',
    0
  );
  if (preflightTerminalResponse) {
    await signalWorkspaceDeletionUnconfirmedCallback(c.env, workspaceId, 'messages');
    return preflightTerminalResponse;
  }

  const body = await parseMessageBatchRequest(c);
  const sessionId = validateMessageBatch(c.env, body);

  // Rule 49: re-read immediately before crossing into ProjectData. Deletion or
  // reassignment that wins while the body is read must suppress all persistence.
  const currentWorkspace = await loadMessageWorkspace(c.env, workspaceId);
  const terminalResponse = maybeTerminalMessageWorkspaceResponse(
    c,
    currentWorkspace,
    workspaceId,
    sessionId,
    body.messages.length
  );
  if (terminalResponse) {
    return terminalResponse;
  }
  if (
    !currentWorkspace ||
    !workspace ||
    !sameWorkspaceCallbackIdentity(currentWorkspace, workspace)
  ) {
    return terminalMessagePersistenceResponse(
      c,
      {
        workspaceId,
        projectId: currentWorkspace?.projectId ?? null,
        sessionId,
        messageCount: body.messages.length,
      },
      currentWorkspace?.status ?? 'missing',
      'workspace_incarnation_changed'
    );
  }
  assertMessageWorkspaceAcceptsBatch(
    c,
    currentWorkspace,
    workspaceId,
    sessionId,
    body.messages.length
  );

  // Delegate to ProjectData DO with structured error handling.
  // On failure, return appropriate status codes so the VM agent outbox
  // can distinguish transient (retry) from permanent (discard) errors.
  const context: MessageRouteContext = {
    workspaceId,
    projectId: currentWorkspace.projectId,
    sessionId,
    messageCount: body.messages.length,
  };
  let result: MessageBatchPersistenceRouteResult;
  const outboxIncarnation = c.req.header(MESSAGE_OUTBOX_INCARNATION_HEADER);
  try {
    result = await projectDataService.persistMessageBatch(
      c.env,
      currentWorkspace.projectId,
      sessionId,
      toProjectDataMessages(body),
      {
        workspaceId,
        callbackGeneration: currentWorkspace.callbackGeneration ?? null,
        // This is transport identity, not an auth claim. Missing/malformed IDs
        // retain the legacy per-message path instead of guessing about replay.
        outboxIncarnation: v.is(v.pipe(v.string(), v.uuid()), outboxIncarnation)
          ? outboxIncarnation.toLowerCase()
          : undefined,
      }
    );
  } catch (err) {
    return handleMessagePersistenceError(c, context, err);
  }

  if (result.limitReached) {
    return partialSessionLimitResponse(c, context, result);
  }

  return c.json({
    persisted: result.persisted,
    duplicates: result.duplicates,
  });
});

// Legacy compatibility endpoint for node-side bootstrap exchange.
// This route requires BOTH user session auth AND callback token auth
// (it was not in the original auth skip list in workspaces.ts).

export { runtimeRoutes as messageRoutes };
